const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const STATIC_DIR = path.join(__dirname, '..', 'simulator');

// ბაზის ინიციალიზაცია
function initDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      adminPin: 'core2026',
      users: [],
      submissions: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  }
}

function readDb() {
  try {
    initDb();
    const content = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error('Error reading db:', err);
    return { adminPin: 'core2026', users: [], submissions: [] };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error writing db:', err);
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) { // 50MB limit
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // =========================================================================
  // API ROUTES
  // =========================================================================

  // 1. მომხმარებლის რეგისტრაცია
  if (pathname === '/api/register' && req.method === 'POST') {
    const payload = await parseBody(req);
    const username = (payload.username || payload.name || '').trim();
    const email = (payload.email || '').trim().toLowerCase();
    const password = (payload.password || payload.pin || '').trim();
    const phone = (payload.phone || '').trim();

    if (!username) {
      return sendJson(res, 400, { error: 'სახელი და გვარი სავალდებულოა' });
    }

    const db = readDb();
    // ვეძებთ არსებულს ელ-ფოსტით ან იუზერნეიმით
    let user = db.users.find(u => 
      (email && u.email && u.email === email) || 
      (u.username && u.username.toLowerCase() === username.toLowerCase())
    );

    if (user) {
      // განახლება
      user.username = username;
      user.name = username;
      if (email) user.email = email;
      if (password) user.password = password;
      if (phone) user.phone = phone;
      user.updatedAt = Date.now();
    } else {
      user = {
        id: 'U-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4),
        username: username,
        name: username,
        email: email || '',
        phone: phone || '',
        password: password || '',
        createdAt: Date.now()
      };
      db.users.push(user);
    }

    writeDb(db);
    return sendJson(res, 200, { success: true, user });
  }

  // 2. მომხმარებლის შესვლა (Login)
  if (pathname === '/api/login' && req.method === 'POST') {
    const payload = await parseBody(req);
    const identifier = (payload.identifier || payload.username || payload.email || '').trim().toLowerCase();
    const password = (payload.password || payload.pin || '').trim();

    if (!identifier) {
      return sendJson(res, 400, { error: 'მიუთითეთ სახელი ან ელ-ფოსტა' });
    }

    const db = readDb();
    const user = db.users.find(u => 
      (u.email && u.email.toLowerCase() === identifier) ||
      (u.username && u.username.toLowerCase() === identifier)
    );

    if (!user) {
      return sendJson(res, 404, { error: 'მომხმარებელი ვერ მოიძებნა' });
    }

    if (user.password && password && user.password !== password) {
      return sendJson(res, 401, { error: 'არასწორი პაროლი' });
    }

    return sendJson(res, 200, { success: true, user });
  }

  // 3. რეგისტრირებული მომხმარებლების სია
  if (pathname === '/api/users' && req.method === 'GET') {
    const db = readDb();
    const safeUsers = db.users.map(u => ({
      id: u.id,
      username: u.username || u.name,
      name: u.name || u.username,
      email: u.email || '',
      phone: u.phone || '',
      hasPassword: Boolean(u.password)
    }));
    return sendJson(res, 200, safeUsers);
  }

  // 4. შედეგის შენახვა (ტესტის დასრულებისას)
  if (pathname === '/api/submit' && req.method === 'POST') {
    const payload = await parseBody(req);
    if (!payload || !payload.id) {
      return sendJson(res, 400, { error: 'არასწორი მონაცემები' });
    }

    const db = readDb();
    // ვამოწმებთ უკვე არსებობს თუ არა ეს სესია
    const existingIdx = db.submissions.findIndex(s => s.id === payload.id);
    if (existingIdx !== -1) {
      db.submissions[existingIdx] = payload;
    } else {
      db.submissions.unshift(payload);
    }

    // შევზღუდოთ ბოლო 10,000 ჩანაწერამდე
    if (db.submissions.length > 10000) {
      db.submissions = db.submissions.slice(0, 10000);
    }

    writeDb(db);
    return sendJson(res, 200, { success: true, id: payload.id });
  }

  // 5. ადმინ პანელის მონაცემები (შედეგების ჟურნალი)
  if (pathname === '/api/admin/journal' && req.method === 'GET') {
    const pin = (parsedUrl.query.pin || '').trim();
    const db = readDb();
    if (pin !== db.adminPin) {
      return sendJson(res, 403, { error: 'წვდომა უარყოფილია: არასწორი ადმინ პაროლი' });
    }
    return sendJson(res, 200, {
      submissions: db.submissions,
      usersCount: db.users.length,
      adminPin: db.adminPin
    });
  }

  // 6. ადმინ პაროლის შეცვლა
  if (pathname === '/api/admin/change-pin' && req.method === 'POST') {
    const payload = await parseBody(req);
    const oldPin = (payload.oldPin || '').trim();
    const newPin = (payload.newPin || '').trim();

    const db = readDb();
    if (oldPin !== db.adminPin) {
      return sendJson(res, 403, { error: 'ძველი პაროლი არასწორია' });
    }
    if (!newPin || newPin.length < 3) {
      return sendJson(res, 400, { error: 'ახალი პაროლი უნდა შეიცავდეს მინიმუმ 3 სიმბოლოს' });
    }

    db.adminPin = newPin;
    writeDb(db);
    return sendJson(res, 200, { success: true });
  }

  // 7. ჟურნალის გასუფთავება (მხოლოდ ადმინისთვის)
  if (pathname === '/api/admin/clear-journal' && req.method === 'POST') {
    const payload = await parseBody(req);
    const pin = (payload.pin || '').trim();
    const db = readDb();
    if (pin !== db.adminPin) {
      return sendJson(res, 403, { error: 'არასწორი პაროლი' });
    }
    db.submissions = [];
    writeDb(db);
    return sendJson(res, 200, { success: true });
  }

  // =========================================================================
  // STATIC FILES (simulator საქაღალდიდან)
  // =========================================================================

  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(STATIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

initDb();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=================================================================`);
  console.log(`  საგამოცდო სისტემის ცენტრალური სერვერი გაშვებულია!`);
  console.log(`  მისამართი (ლოკალურად): http://localhost:${PORT}`);
  console.log(`  მონაცემთა ბაზა: ${DB_FILE}`);
  console.log(`=================================================================`);
});
