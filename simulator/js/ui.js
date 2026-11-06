/**
 * CBT საგამოცდო ინტერფეისის მართვა (UI Controller)
 * საქართველოს ოფიციალური საგამოცდო ცენტრისა და GIPC-ის ფორმატის ზუსტი ანალოგი
 * (100 კითხვა, 180 წუთი, ქვეთავობრივი ჩაჭრის წესი)
 * 
 * მოდულები:
 * - კანდიდატის რეგისტრაცია/იდენტიფიკაცია (სახელი, გვარი, Gmail)
 * - ონლაინ შედეგების ჟურნალი და ადმინ პანელი
 * - პინ-კოდით დაცვა (ნაგულისხმევი 1234, შეცვლის ფუნქციით)
 * - Excel-ში ექსპორტი (CSV UTF-8 BOM ქართული ენის მხარდაჭერით)
 * - Google Sheets / Cloud Webhook ავტომატური სინქრონიზაცია
 */

class ExamUI {
  constructor(engine, calculator) {
    this.engine = engine;
    this.calculator = calculator;
    this.currentFilter = 'all'; // all, unanswered, flagged
    this.reviewFilter = 'all'; // all, errors
    this.keyHandlerBound = null;
    this.candidate = this.loadCandidate();
    this.init();
  }

  init() {
    this.bindGlobalEvents();
    this.candidate = this.loadCandidate();
    this.syncFromCloud().then(() => {
      this.initGoogleIdentity();
    }).catch(() => {});
    this.renderHome();
  }

  getGoogleClientId() {
    return (localStorage.getItem('exam_google_client_id') || '').trim();
  }

  setGoogleClientId(cid) {
    localStorage.setItem('exam_google_client_id', (cid || '').trim());
  }

  parseJwt(token) {
    try {
      const base64Url = token.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        window.atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
      );
      return JSON.parse(jsonPayload);
    } catch (e) {
      return null;
    }
  }

  initGoogleIdentity() {
    const clientId = this.getGoogleClientId();
    if (!clientId || typeof google === 'undefined' || !google.accounts) return;

    try {
      if (google.accounts.id) {
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response && response.credential) {
              const payload = this.parseJwt(response.credential);
              if (payload && payload.email) {
                const fullName = payload.name || payload.email.split('@')[0];
                this.saveCandidate(fullName, payload.email, payload.picture || '');
                this.justSignedIn = true;
                const modal = document.getElementById('genericModalOverlay');
                if (modal) modal.remove();
                if (this.pendingAfterAuth) {
                  const fn = this.pendingAfterAuth;
                  this.pendingAfterAuth = null;
                  fn();
                } else {
                  this.renderHome();
                }
              }
            }
          }
        });
      }
    } catch (e) {
      console.warn('GIS init notice:', e);
    }
  }

  triggerRealGoogleOAuthPopup(onSuccess) {
    const clientId = this.getGoogleClientId();
    if (!clientId) {
      this.promptCandidateModal(onSuccess);
      return;
    }

    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      try {
        const tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: 'openid email profile',
          prompt: 'select_account',
          callback: async (tokenResponse) => {
            if (tokenResponse && tokenResponse.access_token) {
              try {
                const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                  headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
                });
                if (r.ok) {
                  const profile = await r.json();
                  const fullName = profile.name || [profile.given_name, profile.family_name].filter(Boolean).join(' ') || profile.email;
                  this.saveCandidate(fullName, profile.email, profile.picture || '');
                  this.justSignedIn = true;
                  const modal = document.getElementById('genericModalOverlay');
                  if (modal) modal.remove();
                  if (onSuccess) onSuccess();
                  else this.renderHome();
                }
              } catch (err) {
                console.error('Google userinfo error:', err);
              }
            }
          }
        });
        tokenClient.requestAccessToken();
        return;
      } catch (e) {
        console.warn('OAuth2 popup notice:', e);
      }
    }

    this.promptCandidateModal(onSuccess);
  }

  checkGoogleAppsScriptUser() {
    if (typeof google !== 'undefined' && google.script && google.script.run) {
      google.script.run.withSuccessHandler((user) => {
        if (user && user.email) {
          const email = user.email.trim();
          const name = user.name || email.split('@')[0].replace(/[._-]/g, ' ');
          this.saveCandidate(name, email, '');
          this.renderHome();
        }
      }).getUserInfo();
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  setCookie(name, val, days = 365) {
    try {
      const d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      const expires = "expires=" + d.toUTCString();
      document.cookie = `${name}=${encodeURIComponent(val)};${expires};path=/;SameSite=Lax`;
    } catch(e) {}
  }

  getCookie(name) {
    try {
      const cname = name + "=";
      const decoded = decodeURIComponent(document.cookie);
      const ca = decoded.split(';');
      for (let i = 0; i < ca.length; i++) {
        let c = ca[i].trim();
        if (c.indexOf(cname) === 0) return c.substring(cname.length, c.length);
      }
    } catch(e) {}
    return "";
  }

  loadCandidate() {
    try {
      let raw = localStorage.getItem('exam_current_user') || 
                sessionStorage.getItem('exam_candidate') || 
                localStorage.getItem('exam_last_candidate') ||
                localStorage.getItem('exam_saved_candidate') ||
                this.getCookie('exam_current_user');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.name || parsed.email)) {
          return parsed;
        }
      }
      // ავტომატური აღდგენა შენახული მონაცემებიდან (Auto-Login)
      const credsRaw = localStorage.getItem('exam_saved_creds');
      if (credsRaw) {
        const creds = JSON.parse(credsRaw);
        if (creds && (creds.name || creds.email || creds.identifier)) {
          const autoUser = {
            name: creds.name || creds.identifier || creds.email,
            email: creds.email || (creds.identifier && creds.identifier.includes('@') ? creds.identifier : ''),
            phone: creds.phone || '',
            signedIn: true,
            lastLogin: Date.now()
          };
          this.saveCandidate(autoUser.name, autoUser.email, autoUser.phone);
          return autoUser;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  saveCandidate(name, emailOrId, phone = '', picture = '', rememberCreds = null) {
    const cleanEmail = (emailOrId || '').trim().toLowerCase();
    const cleanName = (name || '').trim() || cleanEmail.split('@')[0];
    this.candidate = {
      name: cleanName,
      email: cleanEmail,
      phone: (phone || '').trim(),
      picture: picture || '',
      signedIn: true,
      lastLogin: Date.now()
    };
    const candJson = JSON.stringify(this.candidate);
    try {
      localStorage.setItem('exam_current_user', candJson);
      sessionStorage.setItem('exam_candidate', candJson);
      localStorage.setItem('exam_last_candidate', candJson);
      localStorage.setItem('exam_saved_candidate', candJson);
      if (rememberCreds) {
        localStorage.setItem('exam_saved_creds', JSON.stringify(rememberCreds));
      }
    } catch(e) {}
    this.setCookie('exam_current_user', candJson, 3650); // 10 წლიანი მუდმივი ვადა
  }

  signOutCandidate() {
    this.candidate = null;
    try {
      localStorage.removeItem('exam_current_user');
      sessionStorage.removeItem('exam_candidate');
      localStorage.removeItem('exam_saved_candidate');
    } catch(e) {}
    this.setCookie('exam_current_user', '', -1);
    this.renderHome();
  }

  // ===================== სასწავლო სესიის შენახვა / გაგრძელება =====================

  saveStudyProgress() {
    const exam = this.engine.currentExam;
    if (!exam || exam.mode !== 'study' || exam.isFinished) return;
    try {
      const payload = {
        profileId: exam.profileId,
        currentIndex: exam.currentIndex,
        difficulty: exam.difficulty || 'easy',
        difficultyTitle: exam.difficultyTitle || 'მარტივი',
        userAnswers: exam.userAnswers || {},
        flagged: Array.from(exam.flagged || []),
        questions: exam.questions,
        savedAt: Date.now()
      };
      localStorage.setItem(`exam_study_${exam.profileId}`, JSON.stringify(payload));
    } catch (e) {
      console.warn('Study auto-save error:', e);
    }
  }

  getSavedStudyProgress(profileId) {
    try {
      const raw = localStorage.getItem(`exam_study_${profileId}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.questions) && data.questions.length > 0) {
        return data;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  clearSavedStudyProgress(profileId) {
    try {
      localStorage.removeItem(`exam_study_${profileId}`);
    } catch(e) {}
  }

  getDifficulty() {
    return localStorage.getItem('exam_difficulty') || 'easy';
  }

  setDifficulty(diff) {
    if (!['easy', 'medium', 'hard'].includes(diff)) diff = 'easy';
    localStorage.setItem('exam_difficulty', diff);
  }

  getDifficultyMeta(diff = null) {
    const d = diff || this.getDifficulty();
    const map = {
      easy: {
        id: 'easy',
        title: 'მარტივი',
        badge: '🟢 მარტივი',
        badgeHtml: '<span class="diff-badge diff-easy">🟢 მარტივი</span>',
        hint: 'საბაზისო დონე — სტანდარტული კითხვები და ნორმატიული განმარტებები (არსებული ბაზა)',
        class: 'diff-easy'
      },
      medium: {
        id: 'medium',
        title: 'საშუალო',
        badge: '🟡 საშუალო',
        badgeHtml: '<span class="diff-badge diff-medium">🟡 საშუალო</span>',
        hint: 'საშუალო დონე — პრაქტიკული ქეისები, სიტუაციური შეზღუდვები და გაანგარიშებითი ნორმები',
        class: 'diff-medium'
      },
      hard: {
        id: 'hard',
        title: 'რთული',
        badge: '🔴 რთული 🔥',
        badgeHtml: '<span class="diff-badge diff-hard">🔴 რთული 🔥</span>',
        hint: 'ექსტრემალური დონე — ურთულესი ჩამჭრელი კაზუსები, რთული ფორმულები და მკაცრი გამონაკლისები',
        class: 'diff-hard'
      }
    };
    return map[d] || map.easy;
  }

  resumeStudy(profileId) {
    const saved = this.getSavedStudyProgress(profileId);
    if (!saved) {
      this.startTest(profileId, 'study');
      return;
    }

    const profile = this.engine.structure.profiles[profileId];
    const syllabi = this.engine.structure.syllabi || this.engine.structure.curricula;
    const curriculum = syllabi[profile.field];
    const diff = saved.difficulty || 'easy';
    const diffTitles = { easy: 'მარტივი', medium: 'საშუალო', hard: 'რთული' };

    this.engine.currentExam = {
      profileId,
      profile,
      mode: 'study',
      difficulty: diff,
      difficultyTitle: saved.difficultyTitle || diffTitles[diff] || 'მარტივი',
      curriculum,
      questions: saved.questions,
      userAnswers: saved.userAnswers || {},
      flagged: new Set(saved.flagged || []),
      currentIndex: saved.currentIndex || 0,
      startTime: saved.savedAt || Date.now(),
      durationMinutes: 0,
      remainingSeconds: 0,
      isFinished: false,
      result: null
    };

    this.renderExamInterface();
  }

  formatMath(text) {
    if (!text) return '';
    let s = String(text);

    // 1. Convert LaTeX symbols & Greek alphabet
    s = s.replace(/\\xi/g, 'ξ')
         .replace(/\\sigma/g, 'σ')
         .replace(/\\lambda/g, 'λ')
         .replace(/\\varphi/g, 'φ')
         .replace(/\\phi/g, 'φ')
         .replace(/\\tau/g, 'τ')
         .replace(/\\beta/g, 'β')
         .replace(/\\alpha/g, 'α')
         .replace(/\\gamma/g, 'γ')
         .replace(/\\Delta/g, 'Δ')
         .replace(/\\mu/g, 'μ')
         .replace(/\\pi/g, 'π')
         .replace(/\\psi/g, 'ψ')
         .replace(/\\omega/g, 'ω')
         .replace(/\\approx/g, '≈')
         .replace(/\\times/g, '×')
         .replace(/\\cdot/g, '·')
         .replace(/\\le/g, '≤')
         .replace(/\\ge/g, '≥');

    // Strip dollar signs from formulas
    s = s.replace(/\$([^\$]+)\$/g, '$1');

    // 2. Safe HTML entities for comparison operators (avoid breaking tags)
    s = s.replace(/<(?!\/?(sub|sup|strong|b|i|span|div|br)\b)/gi, '&lt;');
    s = s.replace(/(?<!(sub|sup|strong|b|i|span|div|br|\/))>(?![a-z])/gi, '&gt;');

    s = s.replace(/<=/g, '≤')
         .replace(/>=/g, '≥')
         .replace(/=>/g, '⇒');

    // 3. Format Subscripts: e.g. R_b, R_bt, M_max, h_0, etc.
    s = s.replace(/\b([A-Za-zα-ωΑ-ΩξσλφτβαγΔμπψω])_([0-9a-zA-Zα-ωΑ-ΩξσλφτβαγΔμπψω]+|საყ|მალ|კუთხ|ხაზ|იზ|min|max|ult|cr|ef|zp|zg|bond|sc|sw|nt|bt|bn)\b/g, '$1<sub>$2</sub>');
    s = s.replace(/_\{([^}]+)\}/g, '<sub>$1</sub>');

    // Replace unicode subscripts/superscripts with clean HTML
    s = s.replace(/₀/g, '<sub>0</sub>')
         .replace(/₁/g, '<sub>1</sub>')
         .replace(/₂/g, '<sub>2</sub>')
         .replace(/₃/g, '<sub>3</sub>')
         .replace(/⁴/g, '<sup>4</sup>')
         .replace(/⁵/g, '<sup>5</sup>');

    // 4. Superscripts for powers (e.g. L^2, 10^5, bh^2)
    s = s.replace(/\b([A-Za-z0-9\)])\^([0-9\-]+)\b/g, '$1<sup>$2</sup>');
    s = s.replace(/\b([A-Za-z])²\b/g, '$1<sup>2</sup>');
    s = s.replace(/\b([A-Za-z])³\b/g, '$1<sup>3</sup>');
    s = s.replace(/10⁵/g, '10<sup>5</sup>');
    s = s.replace(/10⁶/g, '10<sup>6</sup>');
    s = s.replace(/10³/g, '10<sup>3</sup>');

    return s;
  }

  formatExtendedExplanation(q, userAnswers = []) {
    let base = (q.explanation || '').trim();
    if (!base) {
      base = 'აღნიშნული მოთხოვნა განისაზღვრება საქართველოს მოქმედი საგამოცდო პროგრამითა და სამშენებლო ნორმებით.';
    }

    const ref = (q.reference || '').toLowerCase();
    const ch = (q.chapterName || '').toLowerCase();
    const sub = (q.subchapterName || '').toLowerCase();
    let normContext = '';

    if (ref.includes('134') || ch.includes('134') || sub.includes('134')) {
      normContext = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#1e3a8a;font-size:13.5px;line-height:1.5;"><strong>📌 საგამოცდო რეგლამენტის მოთხოვნა (№134 დადგენილება):</strong> საგამოცდო წესის თანახმად, ქვეთავობრივი ჩაჭრის წესი მოითხოვს მინიმუმ 70%-იან (ან ექსპერტებისთვის 75%-იან) ზღვარს თითოეულ ქვეთავში ცალ-ცალკე. ამ თემის საფუძვლიანი ცოდნა გადამწყვეტია გამოცდის წარმატებით ჩასაბარებლად.</div>';
    } else if (ref.includes('41') || ch.includes('41') || ref.includes('უსაფრთხოებ')) {
      normContext = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#1e3a8a;font-size:13.5px;line-height:1.5;"><strong>📌 უსაფრთხოების ნორმატივი (დადგენილება №41):</strong> შენობა-ნაგებობათა უსაფრთხოების წესები მოითხოვს მკაცრ დაცვას საევაკუაციო გზების, ხანძარსაწინააღმდეგო ზღუდეებისა და ადამიანთა სიცოცხლის უსაფრთხოების პარამეტრების უზრუნველსაყოფად. ნორმიდან გადახვევა დაუშვებელია.</div>';
    } else if (ref.includes('732') || ch.includes('732') || ref.includes('განაშენიანებ') || ref.includes('გამოყენებ')) {
      normContext = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#1e3a8a;font-size:13.5px;line-height:1.5;"><strong>📌 დაგეგმარების რეგლამენტი (დადგენილება №732):</strong> ტერიტორიების გამოყენებისა და განაშენიანების ძირითადი დებულებები წარმოადგენს გენგეგმის, მიჯნის ზონებისა და კოეფიციენტების (კ-1, კ-2, კ-3) განმსაზღვრელ უმთავრეს სამართლებრივ ჩარჩოს.</div>';
    } else if (ref.includes('255') || ch.includes('ნებართვ') || ch.includes('მშენებლობ')) {
      normContext = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#1e3a8a;font-size:13.5px;line-height:1.5;"><strong>📌 სანებართვო წარმოება (დადგენილება №255):</strong> მშენებლობის ნებართვის გაცემისა და ექსპლუატაციაში მიღების ეტაპობრივი პროცედურა მოითხოვს მკაცრ შესაბამისობას თითოეული კლასის ობიექტისათვის დადგენილ ვადებთან და წარსადგენ დოკუმენტაციასთან.</div>';
    } else if (ref.includes('ევროკოდ') || ref.includes('სეისმ') || ch.includes('კონსტრუქც')) {
      normContext = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #cbd5e1;color:#1e3a8a;font-size:13.5px;line-height:1.5;"><strong>📌 საინჟინრო და კონსტრუქციული ნორმები:</strong> გაანგარიშებისას აუცილებელია დატვირთვების კომბინაციების, მასალის სიმტკიცისა და სეისმომედეგობის კოეფიციენტების ზუსტი გათვალისწინება მოქმედი ნორმებისა და ევროკოდების მიხედვით.</div>';
    }

    return `<div><div style="font-size:14.5px;line-height:1.6;color:#1e293b;">${this.formatMath(base)}</div>${normContext}</div>`;
  }

  // ===================== ცენტრალური ავტორიზაცია (ჰეშით დაცული) =====================

  getSeedAccounts() {
    return {
      'ttamtagedenidze@gmail.com': {
        name: 'თამთა გედენიძე',
        username: 'თამთა გედენიძე',
        email: 'ttamtagedenidze@gmail.com',
        pin: '363636',
        password: '363636',
        phone: '505053580',
        salt: 'tamta2026salt',
        hash: '9bf9ec42c4b2c4c8d5d4ba2f4fe5a8d6268e3eec1790616b251a37c35d949437'
      },
      'konaliaint@gmail.com': {
        name: 'ნკ',
        username: 'ნკ',
        email: 'konaliaint@gmail.com',
        salt: '9xi3koormw3dyo3p',
        hash: '2fa4594e43b4f59495995c2bd4664be6de58fec78d02cea4e9d80fd95b39c4ba'
      },
      'kobaliaint@gmail.com': {
        name: 'nk2',
        username: 'nk2',
        email: 'kobaliaint@gmail.com',
        salt: '1giw4kigmw3e0hji',
        hash: '0a485f67d66978f229c00225c457890801f51f18c26deac6a2639c25ff05ff8d'
      }
    };
  }

  getLocalAccounts() {
    try {
      const seed = this.getSeedAccounts();
      const local = JSON.parse(localStorage.getItem('exam_registered_accounts') || '{}') || {};
      const cache = JSON.parse(localStorage.getItem('exam_cloud_accounts_cache') || '{}') || {};
      return { ...seed, ...cache, ...local };
    } catch(e) {
      return this.getSeedAccounts();
    }
  }

  fallbackHashPassword(password, salt, email) {
    let hash = 0;
    const s = `${salt}:${(email || '').trim().toLowerCase()}:${password}`;
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return 'h_' + Math.abs(hash).toString(16);
  }

  async hashPassword(password, salt, email) {
    try {
      const str = `${salt}:${(email || '').trim().toLowerCase()}:${password}`;
      const enc = new TextEncoder();
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      return this.fallbackHashPassword(password, salt, email);
    }
  }

  findAccount(accounts, identifier) {
    if (!identifier) return null;
    const cleanId = String(identifier).trim().toLowerCase();
    
    // 1. პირდაპირი გასაღებით
    if (accounts[cleanId]) return accounts[cleanId];

    // 2. ელ-ფოსტით
    for (const k in accounts) {
      const a = accounts[k];
      if (a && a.email && a.email.trim().toLowerCase() === cleanId) return a;
    }

    // 3. იუზერნეიმით ან სახელით (ზუსტი დამთხვევა)
    for (const k in accounts) {
      const a = accounts[k];
      if (a && a.username && a.username.trim().toLowerCase() === cleanId) return a;
      if (a && a.name && a.name.trim().toLowerCase() === cleanId) return a;
    }

    // 4. ელ-ფოსტის პრეფიქსით (მაგ. 'ttamtagedenidze' @gmail.com-ის გარეშე)
    for (const k in accounts) {
      const a = accounts[k];
      if (a && a.email) {
        const prefix = a.email.split('@')[0].toLowerCase();
        if (prefix === cleanId) return a;
      }
    }

    // 5. სახელის ნაწილობრივი დამთხვევა
    for (const k in accounts) {
      const a = accounts[k];
      if (a && a.name) {
        const name = a.name.trim().toLowerCase();
        if (name.includes(cleanId) || cleanId.includes(name)) return a;
      }
    }

    return null;
  }

  async verifyPassword(acc, password, enteredId) {
    if (!acc || !password) return false;
    const p = String(password).trim();

    // 1. პირდაპირი PIN / პაროლი (legacy PIN ან პირდაპირი პაროლი)
    if (acc.pin && String(acc.pin).trim() === p) return true;
    if (acc.password && String(acc.password).trim() === p) return true;

    // 2. ჰეშირებული შემოწმება acc.email-ით
    if (acc.hash && acc.salt) {
      const h1 = await this.hashPassword(p, acc.salt, acc.email || enteredId);
      if (h1 === acc.hash) return true;

      if (enteredId) {
        const h2 = await this.hashPassword(p, acc.salt, enteredId);
        if (h2 === acc.hash) return true;
      }

      const h3 = this.fallbackHashPassword(p, acc.salt, acc.email || enteredId);
      if (h3 === acc.hash) return true;
    }

    return false;
  }

  async getCloudAccounts() {
    const all = this.getLocalAccounts();
    try {
      const resp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
      if (resp.ok) {
        const obj = await resp.json();
        if (obj && obj.data) {
          if (obj.data.accounts && typeof obj.data.accounts === 'object') {
            Object.assign(all, obj.data.accounts);
          }
          if (Array.isArray(obj.data.users)) {
            obj.data.users.forEach(u => {
              if (u && (u.email || u.name)) {
                const k = (u.email || u.name).toLowerCase();
                all[k] = {
                  name: u.name || u.username,
                  username: u.username || u.name,
                  email: u.email || '',
                  pin: u.pin || u.password || '',
                  password: u.password || u.pin || '',
                  phone: u.phone || '',
                  ...all[k]
                };
              }
            });
          }
          localStorage.setItem('exam_cloud_accounts_cache', JSON.stringify(all));
        }
      }
    } catch (e) {
      console.warn('Accounts fetch fallback to local cache:', e);
    }
    return all;
  }

  async saveCloudAccount(account) {
    const key = (account.email || account.username || account.name || '').trim().toLowerCase();
    
    // 1. ყოველთვის შევინახოთ ლოკალურ ბაზაში
    let localAccs = {};
    try {
      localAccs = JSON.parse(localStorage.getItem('exam_registered_accounts') || '{}') || {};
    } catch(e) {}
    localAccs[key] = account;
    localStorage.setItem('exam_registered_accounts', JSON.stringify(localAccs));

    let cached = {};
    try {
      cached = JSON.parse(localStorage.getItem('exam_cloud_accounts_cache') || '{}') || {};
    } catch(e) {}
    cached[key] = account;
    localStorage.setItem('exam_cloud_accounts_cache', JSON.stringify(cached));

    // 2. შევეცადოთ ღრუბელში სინქრონიზაციას
    try {
      const getResp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
      let currentData = { entries: [], adminPin: 'core2026', accounts: {} };
      if (getResp.ok) {
        const obj = await getResp.json();
        if (obj && obj.data) currentData = obj.data;
      }
      if (!currentData.accounts || typeof currentData.accounts !== 'object') {
        currentData.accounts = {};
      }
      Object.assign(currentData.accounts, localAccs);
      currentData.accounts[key] = account;
      currentData.updatedAt = Date.now();

      await fetch(this.getCloudApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          name: 'georgia_exam_journal_v1',
          data: currentData
        })
      });
      return true;
    } catch (err) {
      console.warn('Save account to cloud notice (kept safe in local storage):', err);
      return true;
    }
  }

  getAdminPin() {
    return localStorage.getItem('exam_admin_pin') || 'core2026';
  }

  setAdminPin(pin) {
    localStorage.setItem('exam_admin_pin', pin.trim());
  }

  bindGlobalEvents() {
    this.engine.onTick = (remainingSec) => {
      this.updateTimerDisplay(remainingSec);
    };

    this.engine.onTimeUp = () => {
      alert("საგამოცდო დრო (120 წთ) ამოიწურა! თქვენი ნაშრომი გადაგზავნილია შესაფასებლად.");
      this.renderResults();
    };
  }

  promptCandidateModal(onSuccess) {
    const existing = document.getElementById('genericModalOverlay');
    if (existing) existing.remove();

    this.pendingAfterAuth = onSuccess || null;

    let savedCreds = null;
    try { savedCreds = JSON.parse(localStorage.getItem('exam_saved_creds') || '{}'); } catch(e) {}
    let lastCand = null;
    try { lastCand = JSON.parse(localStorage.getItem('exam_last_candidate') || localStorage.getItem('exam_saved_candidate') || '{}'); } catch(e) {}
    const quickUser = (savedCreds && (savedCreds.name || savedCreds.identifier)) ? savedCreds : ((lastCand && (lastCand.name || lastCand.email)) ? lastCand : null);

    const savedId = (savedCreds && (savedCreds.identifier || savedCreds.email)) || (lastCand && (lastCand.email || lastCand.name)) || '';
    const savedPass = (savedCreds && savedCreds.password) || '';

    const overlay = document.createElement('div');
    overlay.id = 'genericModalOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:440px;">
        <div class="modal-header" style="border-bottom:1px solid #e2e8f0;padding-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:24px;">👤</span>
            <div>
              <h3 style="margin:0;font-size:18px;color:#0f172a;font-weight:700;">საგამოცდო პროფილი</h3>
              <p style="margin:2px 0 0;font-size:12px;color:#64748b;">ავტორიზაცია და რეგისტრაცია</p>
            </div>
          </div>
          <button class="modal-close-btn" id="modalCloseBtn">&times;</button>
        </div>

        ${quickUser ? `
          <div style="background:#eff6ff;border-bottom:1px solid #dbeafe;padding:12px 18px;text-align:left;">
            <div style="font-size:11.5px;color:#1e40af;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
              <span>⚡</span> <span>სწრაფი შესვლა (პაროლის გარეშე):</span>
            </div>
            <button type="button" id="btnQuickAutoLogin" style="width:100%;display:flex;align-items:center;justify-content:space-between;background:#2563eb;color:#fff;border:none;padding:9px 12px;border-radius:6px;font-weight:700;font-size:13.5px;cursor:pointer;box-shadow:0 1px 2px rgba(37,99,235,0.2);">
              <span style="text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">👤 ${this.escapeHtml(quickUser.name || quickUser.identifier)} ${quickUser.email ? `<span style="font-size:12px;opacity:0.85;font-weight:400;">(${this.escapeHtml(quickUser.email)})</span>` : ''}</span>
              <span style="margin-left:8px;white-space:nowrap;">შესვლა ➔</span>
            </button>
          </div>
        ` : ''}

        <!-- ტაბების გადართვა: შესვლა / რეგისტრაცია -->
        <div style="display:flex;background:#f1f5f9;border-bottom:1px solid #e2e8f0;padding:4px 6px;gap:6px;">
          <button type="button" id="tabBtnLogin" style="flex:1;padding:9px;font-size:13.5px;font-weight:700;border:none;border-radius:6px;cursor:pointer;background:#fff;color:#1e293b;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
            🔑 სისტემაში შესვლა
          </button>
          <button type="button" id="tabBtnRegister" style="flex:1;padding:9px;font-size:13.5px;font-weight:700;border:none;border-radius:6px;cursor:pointer;background:transparent;color:#64748b;box-shadow:none;">
            📝 ახალი რეგისტრაცია
          </button>
        </div>

        <div class="modal-body" style="padding:18px 22px;">
          <!-- ჩანართი 1: შესვლა -->
          <div id="authPaneLogin" style="display:block;">
            <p style="font-size:13px;color:#475569;margin-bottom:14px;line-height:1.45;">
              შეიყვანეთ თქვენი ელ-ფოსტა ან სახელი და პაროლი:
            </p>
            <form id="formLogin" onsubmit="return false;">
              <div class="form-group" style="margin-bottom:12px;text-align:left;">
                <label class="form-label" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">
                  Gmail / ელ-ფოსტა ან სახელი:
                </label>
                <input type="text" id="loginIdentifier" class="form-input" placeholder="მაგ: g.beridze@gmail.com ან გიორგი ბერიძე" value="${this.escapeHtml(savedId)}" style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;" required autofocus>
              </div>
              <div class="form-group" style="margin-bottom:10px;text-align:left;">
                <label class="form-label" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">
                  პაროლი / PIN:
                </label>
                <div style="position:relative;display:flex;align-items:center;">
                  <input type="password" id="loginPassword" class="form-input" placeholder="••••••••" value="${this.escapeHtml(savedPass)}" style="width:100%;font-size:14px;padding:10px 38px 10px 12px;box-sizing:border-box;" required>
                  <button type="button" id="btnToggleLoginPass" title="პაროლის ჩვენება" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;font-size:16px;color:#64748b;padding:4px;">👁️</button>
                </div>
              </div>
              <div style="margin-bottom:14px;text-align:left;">
                <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#334155;cursor:pointer;user-select:none;">
                  <input type="checkbox" id="chkRememberMe" checked style="width:16px;height:16px;accent-color:#2563eb;cursor:pointer;">
                  <span><strong>დამიმახსოვრე</strong> ამ მოწყობილობაზე (ავტომატური შესვლა)</span>
                </label>
              </div>
              <div id="loginErrorMsg" style="color:#dc2626;font-size:13px;display:none;margin-bottom:12px;font-weight:600;background:#fef2f2;padding:8px 12px;border-radius:6px;border:1px solid #fecaca;line-height:1.45;"></div>
              <button type="submit" id="btnLoginSubmit" class="btn btn-primary" style="width:100%;padding:11px;font-size:14.5px;font-weight:700;border-radius:8px;cursor:pointer;">
                🔑 შესვლა
              </button>
              <div style="text-align:center;margin-top:14px;">
                <button type="button" id="linkGoToReg" style="background:none;border:none;color:#2563eb;font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline;">
                  არ გაქვთ ანგარიში? დარეგისტრირდით აქ 📝
                </button>
              </div>
            </form>
          </div>

          <!-- ჩანართი 2: რეგისტრაცია -->
          <div id="authPaneRegister" style="display:none;">
            <p style="font-size:13px;color:#475569;margin-bottom:14px;line-height:1.45;">
              გაიარეთ <strong>ერთჯერადი რეგისტრაცია</strong>. სისტემა დაგიმახსოვრებთ ავტომატურად:
            </p>
            <form id="formRegister" onsubmit="return false;">
              <div class="form-group" style="margin-bottom:12px;text-align:left;">
                <label class="form-label" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">
                  სახელი და გვარი <span style="color:#dc2626;">*</span>:
                </label>
                <input type="text" id="regName" class="form-input" placeholder="მაგ: გიორგი ბერიძე" style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;" required>
              </div>
              <div class="form-group" style="margin-bottom:12px;text-align:left;">
                <label class="form-label" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">
                  Gmail / ელ-ფოსტა ან მომხმარებლის სახელი <span style="color:#dc2626;">*</span>:
                </label>
                <input type="text" id="regEmail" class="form-input" placeholder="მაგ: g.beridze@gmail.com" style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;" required>
              </div>
              <div class="form-group" style="margin-bottom:10px;text-align:left;">
                <label class="form-label" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">
                  მოიფიქრეთ პაროლი ან PIN <span style="color:#dc2626;">*</span>:
                </label>
                <div style="position:relative;display:flex;align-items:center;">
                  <input type="password" id="regPassword" class="form-input" placeholder="მინიმუმ 3 სიმბოლო (მაგ. 1234 ან 363636)" style="width:100%;font-size:14px;padding:10px 38px 10px 12px;box-sizing:border-box;" required>
                  <button type="button" id="btnToggleRegPass" title="პაროლის ჩვენება" style="position:absolute;right:8px;background:none;border:none;cursor:pointer;font-size:16px;color:#64748b;padding:4px;">👁️</button>
                </div>
              </div>
              <div style="margin-bottom:14px;text-align:left;">
                <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#334155;cursor:pointer;user-select:none;">
                  <input type="checkbox" id="chkRegRememberMe" checked style="width:16px;height:16px;accent-color:#059669;cursor:pointer;">
                  <span><strong>დამიმახსოვრე</strong> ამ მოწყობილობაზე (ავტომატური შესვლა)</span>
                </label>
              </div>
              <div id="regErrorMsg" style="color:#dc2626;font-size:13px;display:none;margin-bottom:12px;font-weight:600;background:#fef2f2;padding:8px 12px;border-radius:6px;border:1px solid #fecaca;line-height:1.45;"></div>
              <button type="submit" id="btnRegSubmit" class="btn btn-primary" style="width:100%;padding:11px;font-size:14.5px;font-weight:700;border-radius:8px;cursor:pointer;background:#059669;border-color:#059669;">
                📝 რეგისტრაცია და დაწყება
              </button>
              <div style="text-align:center;margin-top:14px;">
                <button type="button" id="linkGoToLogin" style="background:none;border:none;color:#2563eb;font-size:13px;font-weight:600;cursor:pointer;text-decoration:underline;">
                  უკვე გაქვთ პროფილი? შედით სისტემაში 🔑
                </button>
              </div>
            </form>
          </div>
        </div>

        <div class="modal-footer" style="justify-content:flex-end;">
          <button class="btn btn-secondary" id="modalCancelBtn">დახურვა</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('modalCloseBtn').onclick = close;
    document.getElementById('modalCancelBtn').onclick = close;

    const btnQuick = document.getElementById('btnQuickAutoLogin');
    if (btnQuick && quickUser) {
      btnQuick.onclick = () => {
        this.saveCandidate(quickUser.name || quickUser.identifier, quickUser.email || '', quickUser.phone || '');
        finishAuth();
      };
    }

    // Toggle Password Visibility
    const setupPassToggle = (btnId, inputId) => {
      const btn = document.getElementById(btnId);
      const inp = document.getElementById(inputId);
      if (btn && inp) {
        btn.onclick = () => {
          if (inp.type === 'password') {
            inp.type = 'text';
            btn.innerText = '🙈';
          } else {
            inp.type = 'password';
            btn.innerText = '👁️';
          }
        };
      }
    };
    setupPassToggle('btnToggleLoginPass', 'loginPassword');
    setupPassToggle('btnToggleRegPass', 'regPassword');

    const tabLogin = document.getElementById('tabBtnLogin');
    const tabReg = document.getElementById('tabBtnRegister');
    const paneLogin = document.getElementById('authPaneLogin');
    const paneReg = document.getElementById('authPaneRegister');

    const showLoginTab = () => {
      tabLogin.style.background = '#fff';
      tabLogin.style.color = '#1e293b';
      tabLogin.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      tabReg.style.background = 'transparent';
      tabReg.style.color = '#64748b';
      tabReg.style.boxShadow = 'none';
      paneLogin.style.display = 'block';
      paneReg.style.display = 'none';
      document.getElementById('loginIdentifier').focus();
    };

    const showRegisterTab = () => {
      tabReg.style.background = '#fff';
      tabReg.style.color = '#1e293b';
      tabReg.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
      tabLogin.style.background = 'transparent';
      tabLogin.style.color = '#64748b';
      tabLogin.style.boxShadow = 'none';
      paneReg.style.display = 'block';
      paneLogin.style.display = 'none';
      document.getElementById('regName').focus();
    };

    tabLogin.onclick = showLoginTab;
    tabReg.onclick = showRegisterTab;

    const linkGoReg = document.getElementById('linkGoToReg');
    if (linkGoReg) {
      linkGoReg.onclick = () => {
        const idVal = (document.getElementById('loginIdentifier').value || '').trim();
        if (idVal) document.getElementById('regEmail').value = idVal;
        showRegisterTab();
      };
    }

    const linkGoLog = document.getElementById('linkGoToLogin');
    if (linkGoLog) {
      linkGoLog.onclick = () => {
        const idVal = (document.getElementById('regEmail').value || '').trim();
        if (idVal) document.getElementById('loginIdentifier').value = idVal;
        showLoginTab();
      };
    }

    const finishAuth = () => {
      this.justSignedIn = true;
      close();
      if (this.pendingAfterAuth) {
        const fn = this.pendingAfterAuth;
        this.pendingAfterAuth = null;
        fn();
      } else {
        this.renderHome();
      }
    };

    // შესვლა
    document.getElementById('formLogin').onsubmit = async (e) => {
      e.preventDefault();
      const identifier = (document.getElementById('loginIdentifier').value || '').trim();
      const password = (document.getElementById('loginPassword').value || '').trim();
      const rememberMe = document.getElementById('chkRememberMe').checked;
      const errBox = document.getElementById('loginErrorMsg');
      const submitBtn = document.getElementById('btnLoginSubmit');

      errBox.style.display = 'none';
      if (!identifier) {
        errBox.innerText = 'გთხოვთ შეიყვანოთ ელ-ფოსტა ან თქვენი სახელი!';
        errBox.style.display = 'block';
        return;
      }
      if (!password) {
        errBox.innerText = 'გთხოვთ შეიყვანოთ პაროლი!';
        errBox.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerText = 'მოწმდება...';

      try {
        const accounts = await this.getCloudAccounts();
        const acc = this.findAccount(accounts, identifier);
        if (!acc) {
          errBox.innerHTML = `მომხმარებელი "<strong>${this.escapeHtml(identifier)}</strong>" ვერ მოიძებნა.<br><a href="#" id="inlineToReg" style="color:#2563eb;text-decoration:underline;font-weight:700;">გადადით რეგისტრაციის ჩანართზე 👉</a>`;
          errBox.style.display = 'block';
          const link = document.getElementById('inlineToReg');
          if (link) {
            link.onclick = (ev) => {
              ev.preventDefault();
              document.getElementById('regEmail').value = identifier;
              showRegisterTab();
            };
          }
          submitBtn.disabled = false;
          submitBtn.innerText = '🔑 შესვლა';
          return;
        }

        const isValid = await this.verifyPassword(acc, password, identifier);
        if (!isValid) {
          errBox.innerText = 'არასწორი პაროლი! გთხოვთ გადაამოწმოთ.';
          errBox.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.innerText = '🔑 შესვლა';
          return;
        }

        this.saveCandidate(
          acc.name || identifier,
          acc.email || identifier,
          acc.phone || '',
          acc.picture || '',
          rememberMe ? { identifier, password, name: acc.name, email: acc.email } : null
        );
        finishAuth();
      } catch (err) {
        errBox.innerText = 'შეცდომა ავტორიზაციისას: ' + (err.message || err);
        errBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.innerText = '🔑 შესვლა';
      }
    };

    // რეგისტრაცია
    document.getElementById('formRegister').onsubmit = async (e) => {
      e.preventDefault();
      const name = (document.getElementById('regName').value || '').trim();
      const identifier = (document.getElementById('regEmail').value || '').trim();
      const password = (document.getElementById('regPassword').value || '').trim();
      const rememberMe = document.getElementById('chkRegRememberMe').checked;
      const errBox = document.getElementById('regErrorMsg');
      const submitBtn = document.getElementById('btnRegSubmit');

      errBox.style.display = 'none';
      if (!name || name.length < 2) {
        errBox.innerText = 'გთხოვთ მიუთითოთ თქვენი სახელი და გვარი (საგამოცდო უწყისისთვის)!';
        errBox.style.display = 'block';
        return;
      }
      if (!identifier) {
        errBox.innerText = 'გთხოვთ შეიყვანოთ ელ-ფოსტა ან მომხმარებლის სახელი!';
        errBox.style.display = 'block';
        return;
      }
      if (!password || password.length < 3) {
        errBox.innerText = 'პაროლი უნდა იყოს მინიმუმ 3 სიმბოლო!';
        errBox.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerText = 'მუშავდება...';

      try {
        const accounts = await this.getCloudAccounts();
        const existingAcc = this.findAccount(accounts, identifier);

        // თუ მომხმარებელი უკვე არსებობს, ვუახლებთ პაროლს და პირდაპირ ვუშვებთ (აღარ იბლოკება!)
        if (existingAcc) {
          existingAcc.name = name || existingAcc.name;
          existingAcc.pin = password;
          existingAcc.password = password;
          existingAcc.salt = Math.random().toString(36).substring(2, 10);
          existingAcc.hash = await this.hashPassword(password, existingAcc.salt, existingAcc.email || identifier);
          existingAcc.updatedAt = Date.now();

          await this.saveCloudAccount(existingAcc);
          this.saveCandidate(
            existingAcc.name,
            existingAcc.email || identifier,
            existingAcc.phone || '',
            existingAcc.picture || '',
            rememberMe ? { identifier, password, name: existingAcc.name, email: existingAcc.email } : null
          );
          finishAuth();
          return;
        }

        const salt = Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
        const hash = await this.hashPassword(password, salt, identifier);
        const cleanEmail = identifier.includes('@') ? identifier.toLowerCase() : '';
        const newAccount = {
          name,
          username: name,
          email: cleanEmail,
          pin: password,
          password: password,
          salt,
          hash,
          createdAt: Date.now()
        };

        await this.saveCloudAccount(newAccount);
        this.saveCandidate(
          name,
          cleanEmail || identifier,
          '',
          '',
          rememberMe ? { identifier, password, name, email: cleanEmail } : null
        );
        finishAuth();
      } catch (err) {
        errBox.innerText = 'რეგისტრაციის შეცდომა: ' + (err.message || err);
        errBox.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.innerText = '📝 რეგისტრაცია და დაწყება';
      }
    };
  }


  promptAdminLogin() {
    const existing = document.getElementById('genericModalOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'genericModalOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h3>🔐 ადმინისტრატორის ავტორიზაცია</h3>
          <button class="modal-close-btn" id="modalCloseBtn">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">შეიყვანეთ ადმინისტრატორის საიდუმლო პაროლი:</label>
            <input type="password" id="adminPinInput" class="form-input" placeholder="••••••••" maxlength="30" autofocus>
            <div class="form-hint">წვდომა დაცულია და განკუთვნილია მხოლოდ სისტემის ადმინისტრატორისთვის.</div>
            <div id="pinErrorMsg" style="color:#dc2626;font-size:13px;display:none;margin-top:8px;">❌ არასწორი პაროლი! წვდომა უარყოფილია.</div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCancelBtn">გაუქმება</button>
          <button class="btn btn-primary" id="pinSubmitBtn">შესვლა</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('modalCloseBtn').onclick = close;
    document.getElementById('modalCancelBtn').onclick = close;

    const checkPin = async () => {
      const btn = document.getElementById('pinSubmitBtn');
      const entered = document.getElementById('adminPinInput').value.trim();
      if (!entered) return;

      if (btn) btn.innerText = 'მოწმდება...';
      await this.syncFromCloud().catch(() => {});
      if (btn) btn.innerText = 'შესვლა';

      const currentPin = this.getAdminPin();
      if (entered === currentPin) {
        close();
        this.renderAdminPanel(true);
      } else {
        const err = document.getElementById('pinErrorMsg');
        if (err) err.style.display = 'block';
        const inp = document.getElementById('adminPinInput');
        if (inp) {
          inp.value = '';
          inp.focus();
        }
      }
    };

    document.getElementById('pinSubmitBtn').onclick = checkPin;
    document.getElementById('adminPinInput').onkeydown = (e) => {
      if (e.key === 'Enter') checkPin();
    };
  }

  renderHome() {
    if (this.keyHandlerBound) {
      window.removeEventListener('keydown', this.keyHandlerBound);
      this.keyHandlerBound = null;
    }

    const app = document.getElementById('app');
    const profiles = this.engine.structure.profiles;
    const isSigned = Boolean(this.candidate && (this.candidate.name || this.candidate.email));
    const showSignedBanner = Boolean(this.justSignedIn);
    this.justSignedIn = false;

    const currentDiff = this.getDifficulty();
    const diffMeta = this.getDifficultyMeta(currentDiff);

    app.innerHTML = `
      <div class="home-container">
        <!-- ზედა მართვის ზოლი -->
        <div class="top-nav-bar">
          <div class="candidate-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span class="cand-name" id="homeCandDisplay" style="display:inline-flex;align-items:center;gap:8px;background:${isSigned ? '#dafbe1' : '#f6f8fa'};border:1px solid ${isSigned ? '#4ac26b' : '#d0d7de'};padding:5px 12px;border-radius:6px;font-weight:600;font-size:13px;color:${isSigned ? '#1a7f37' : '#57606a'};">
              ${isSigned && this.candidate.picture ? `<img src="${this.escapeHtml(this.candidate.picture)}" alt="" style="width:20px;height:20px;border-radius:50%;">` : ''}
              ${isSigned ? `🟢 <strong>${this.escapeHtml(this.candidate.name || this.candidate.email)}</strong> ${this.candidate.email && this.candidate.name ? `<span style="font-size:12px;opacity:0.85;">(${this.escapeHtml(this.candidate.email)})</span>` : ''}` : '⚪ არ ხართ შესული'}
            </span>
            ${!isSigned ? `<button class="btn btn-subtle" id="btnChangeCand" style="display:inline-flex;align-items:center;gap:6px;background:#f6f8fa;border:1px solid #d0d7de;padding:5px 12px;border-radius:6px;font-weight:600;font-size:13px;color:#24292f;cursor:pointer;box-shadow:0 1px 0 rgba(27,31,36,0.04);">
              <span>🔐</span>
              <span>შესვლა / რეგისტრაცია</span>
            </button>` : ''}
            ${isSigned ? `<button class="btn btn-subtle" id="btnSignOutCand" style="padding:5px 12px;border-radius:6px;font-size:12.5px;font-weight:600;color:#cf222e;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer;">🚪 გასვლა</button>` : ''}
          </div>

          <!-- სირთულის 3-პოზიციიანი გადამრთველი (მარტივი, საშუალო, რთული) ადმინ პანელის ზოლზე -->
          <div class="diff-nav-wrapper" id="diffNavWrapper">
            <span class="diff-nav-title">🎯 სირთულე:</span>
            <div class="diff-segmented-group" role="radiogroup" aria-label="სირთულის დონე">
              <button type="button" class="btn-diff-segment ${currentDiff === 'easy' ? 'active diff-easy' : ''}" data-diff="easy" title="მარტივი — საბაზისო კითხვები და სტანდარტული განმარტებები (არსებული ბაზა)">
                <span class="diff-dot-icon">🟢</span>
                <span class="diff-name">მარტივი</span>
              </button>
              <button type="button" class="btn-diff-segment ${currentDiff === 'medium' ? 'active diff-medium' : ''}" data-diff="medium" title="საშუალო — გაღრმავებული პრაქტიკული ქეისები და შეზღუდვები">
                <span class="diff-dot-icon">🟡</span>
                <span class="diff-name">საშუალო</span>
              </button>
              <button type="button" class="btn-diff-segment ${currentDiff === 'hard' ? 'active diff-hard' : ''}" data-diff="hard" title="რთული — ექსტრემალური/უმაღლესი სირთულე, ჩამჭრელი კაზუსები და რთული ფორმულები">
                <span class="diff-dot-icon">🔴</span>
                <span class="diff-name">რთული 🔥</span>
              </button>
            </div>
          </div>

          <div class="admin-bar">
            <button class="btn btn-admin" id="btnAdminLogin">🔐 ადმინ პანელი</button>
          </div>
        </div>

        ${showSignedBanner ? `
          <div style="background:#dafbe1;border:1px solid #4ac26b;color:#1a7f37;padding:12px 18px;border-radius:6px;margin-bottom:16px;font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:10px;">
            <span>✅</span>
            <span>ავტორიზაცია წარმატებულია: <strong>${this.escapeHtml(this.candidate.name)}</strong> (${this.escapeHtml(this.candidate.email)})</span>
          </div>
        ` : ''}

        <header class="home-header">
          <h1>არქიტექტორების, ინჟინერ-მშენებლებისა და ექსპერტების სერტიფიცირების საგამოცდო სისტემა</h1>
          <p class="subtitle">საქართველოს მთავრობის №134 დადგენილების, №41, №732, №255, №261 დადგენილებებისა და სამშენებლო კოდექსის (№3213-რს) საგამოცდო სიმულატორი</p>
          <div class="mandatory-date-badge">
            სავალდებულო სერტიფიცირების ამოქმედების თარიღი: <strong>2026 წლის 20 დეკემბერი</strong>
          </div>
        </header>

        <section class="profile-selection-section">
          <h2>აირჩიეთ საგამოცდო პროფილი და რეჟიმი:</h2>
          <div class="profile-cards-grid">
            ${Object.values(profiles).map(p => {
              const savedStudy = this.getSavedStudyProgress(p.id);
              const answeredCount = savedStudy ? Object.keys(savedStudy.userAnswers || {}).length : 0;
              return `
              <div class="profile-card" data-id="${p.id}">
                <div class="card-field-tag ${p.field}">${p.field === 'architecture' ? 'არქიტექტურა' : 'კონსტრუქცია'}</div>
                <h3 class="profile-name">${p.title}</h3>
                <div class="profile-criteria">
                  <div class="crit-row">
                    <span class="crit-label">სირთულის დონე:</span>
                    <span class="crit-val">${diffMeta.badgeHtml}</span>
                  </div>
                  <div class="crit-row">
                    <span class="crit-label">საკვალიფიკაციო მოთხოვნა:</span>
                    <span class="crit-val">${p.qualification}</span>
                  </div>
                  <div class="crit-row highlight">
                    <span class="crit-label">საგამოცდო ბარიერი:</span>
                    <span class="crit-val">≥ ${(p.passing_score_subchapter * 100).toFixed(0)}% თითოეულ ქვეთავში ცალ-ცალკე!</span>
                  </div>
                  <div class="crit-row">
                    <span class="crit-label">ფორმატი და დრო:</span>
                    <span class="crit-val">100 კითხვა • 120 წუთი (2 საათი) • CBT</span>
                  </div>
                </div>
                <div class="card-actions">
                  <button class="btn btn-primary start-exam-btn" data-id="${p.id}" data-mode="exam">
                    საგამოცდო რეჟიმი (120 წთ, 100 კითხვა)
                  </button>
                  ${savedStudy && answeredCount > 0 ? `
                    <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                      <button class="btn btn-success resume-study-btn" data-id="${p.id}" style="background:#059669;color:#fff;font-weight:700;border:none;padding:10px;border-radius:6px;cursor:pointer;">
                        ▶️ სწავლის გაგრძელება (${answeredCount}/100 კითხვა)
                      </button>
                      <button class="btn btn-subtle restart-study-btn" data-id="${p.id}" style="font-size:12px;color:#64748b;background:transparent;border:none;cursor:pointer;text-decoration:underline;">
                        🔄 თავიდან დაწყება (ახალი სესია)
                      </button>
                    </div>
                  ` : `
                    <button class="btn btn-secondary start-study-btn" data-id="${p.id}" data-mode="study">
                      სასწავლო რეჟიმი (დროის გარეშე, განმარტებებით)
                    </button>
                  `}
                </div>
              </div>
            `;
            }).join('')}
          </div>
        </section>

        <section class="exam-rules-banner">
          <h3>საგამოცდო რეგლამენტის კრიტიკული მოთხოვნები (№134 დადგენილება):</h3>
          <div class="rules-list">
            <div class="rule-item">
              <span class="rule-icon">⚠️</span>
              <div>
                <strong>ქვეთავობრივი ჩაჭრის წესი:</strong> საერთო 90%-იც კი არ ითვლება ჩაბარებად, თუ აპლიკანტმა თუნდაც ერთ ქვეთავში ვერ გადალახა 70% (ან ექსპერტისთვის 75%) ზღვარი.
              </div>
            </div>
            <div class="rule-item">
              <span class="rule-icon">🎲</span>
              <div>
                <strong>დინამიური რანდომიზაცია:</strong> ყოველ ჯერზე გენერირდება ახალი 100 კითხვა ოფიციალური ქვეთავობრივი კვოტების მკაცრი დაცვით, ხოლო პასუხების ვარიანტები (A, B, C, D) შემთხვევითად ირევა.
              </div>
            </div>
            <div class="rule-item">
              <span class="rule-icon">📐</span>
              <div>
                <strong>საინჟინრო SI კალკულატორი:</strong> ტესტირებისას ნებადართულია მხოლოდ თანდართული საინჟინრო SI კალკულატორი გრადუსებისა (DEG) და რადიანების (RAD) მხარდაჭერით.
              </div>
            </div>
            <div class="rule-item">
              <span class="rule-icon">⏱️</span>
              <div>
                <strong>დროის რეგლამენტი და შეფასება:</strong> საგამოცდო დრო შეადგენს 120 წუთს (2 საათი). დროის ამოწურვისას ნაშრომი ავტომატურად იგზავნება და გენერირდება დეტალური უწყისი.
              </div>
            </div>
          </div>
        </section>
      </div>
    `;

    // ივენთები
    const changeCandBtn = document.getElementById('btnChangeCand');
    if (changeCandBtn) {
      changeCandBtn.onclick = () => this.promptCandidateModal(() => this.renderHome());
    }

    const signOutBtn = document.getElementById('btnSignOutCand');
    if (signOutBtn) {
      signOutBtn.onclick = () => this.signOutCandidate();
    }

    document.getElementById('btnAdminLogin').onclick = () => {
      this.promptAdminLogin();
    };

    app.querySelectorAll('.btn-diff-segment').forEach(btn => {
      btn.onclick = () => {
        const d = btn.getAttribute('data-diff');
        this.setDifficulty(d);
        this.renderHome();
      };
    });

    app.querySelectorAll('.start-exam-btn, .start-study-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const profileId = e.currentTarget.getAttribute('data-id');
        const mode = e.currentTarget.getAttribute('data-mode');
        this.startTestWithCheck(profileId, mode);
      });
    });

    app.querySelectorAll('.resume-study-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const profileId = e.currentTarget.getAttribute('data-id');
        this.startTestWithCheck(profileId, 'resume');
      });
    });

    app.querySelectorAll('.restart-study-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const profileId = e.currentTarget.getAttribute('data-id');
        if (confirm("დარწმუნებული ხართ, რომ გსურთ მიმდინარე სასწავლო პროგრესის წაშლა და თავიდან დაწყება?")) {
          this.clearSavedStudyProgress(profileId);
          this.startTestWithCheck(profileId, 'study');
        }
      });
    });
  }

  startTestWithCheck(profileId, mode) {
    if (!this.candidate || (!this.candidate.name && !this.candidate.email)) {
      this.promptCandidateModal(() => {
        if (mode === 'resume') this.resumeStudy(profileId);
        else this.startTest(profileId, mode);
      });
      return;
    }
    if (mode === 'resume') {
      this.resumeStudy(profileId);
    } else {
      this.startTest(profileId, mode);
    }
  }

  startTest(profileId, mode) {
    const diff = this.getDifficulty();
    this.engine.startExam(profileId, mode, diff);
    this.renderExamInterface();
  }

  renderExamInterface() {
    const exam = this.engine.currentExam;
    const app = document.getElementById('app');

    app.innerHTML = `
      <div class="exam-layout">
        <!-- ზედა მართვის ზოლი -->
        <header class="exam-header">
          <div class="header-left">
            <span class="badge profile-badge">${exam.profile.title}</span>
            <span class="badge mode-badge ${exam.mode}">${exam.mode === 'exam' ? 'საგამოცდო რეჟიმი' : 'სასწავლო რეჟიმი'}</span>
            <span class="badge diff-badge ${exam.difficulty || 'easy'}">${exam.difficulty === 'hard' ? '🔴 რთული 🔥' : (exam.difficulty === 'medium' ? '🟡 საშუალო' : '🟢 მარტივი')}</span>
            <span class="badge candidate-badge" style="background:#ecfdf5;color:#065f46;border:1.5px solid #10b981;font-weight:700;">🟢 ავტორიზებულია: ${this.candidate ? this.escapeHtml(this.candidate.name) : ''}</span>
            <span class="passing-rule-hint">ბარიერი: ≥ ${(exam.profile.passing_score_subchapter * 100).toFixed(0)}% ქვეთავში</span>
          </div>

          <div class="header-center">
            ${exam.mode === 'study' ? `
              <div class="timer-box" style="background:#ecfdf5;border:1.5px solid #10b981;color:#065f46;padding:7px 16px;border-radius:20px;font-size:13.5px;font-weight:700;display:inline-flex;align-items:center;gap:8px;">
                <span style="font-size:16px;">📖</span>
                <span>სასწავლო რეჟიმი (დროის ლიმიტის გარეშე)</span>
              </div>
            ` : `
              <div class="timer-box" id="timerBox">
                <span class="timer-icon">⏱️</span>
                <span id="timerDigits" class="timer-digits">02:00:00</span>
              </div>
            `}
          </div>

          <div class="header-right">
            ${exam.mode === 'study' ? `
              <button id="pauseStudyBtn" class="btn btn-secondary" style="margin-right:8px;font-weight:700;background:#f8fafc;border:1.5px solid #cbd5e1;color:#1e293b;" title="პროგრესის შენახვა და საიტზე დაბრუნება">
                💾 შენახვა და გასვლა
              </button>
            ` : ''}
            <button id="docsToggleBtn" class="btn btn-secondary" style="margin-right:8px;font-weight:700;background:#eff6ff;border:1.5px solid #3b82f6;color:#1d4ed8;" title="ოფიციალური საგამოცდო დოკუმენტაცია">
              📖 საგამოცდო დოკუმენტაცია
            </button>
            <button id="calcToggleBtn" class="btn btn-icon" title="საინჟინრო კალკულატორი">
              ⚙️ კალკულატორი
            </button>
            <button id="finishExamBtn" class="btn ${exam.mode === 'study' ? 'btn-success' : 'btn-danger'}" style="${exam.mode === 'study' ? 'background:#059669;border-color:#059669;' : ''}">
              ${exam.mode === 'study' ? '🏁 შედეგების შეჯამება' : 'გამოცდის დასრულება'}
            </button>
          </div>
        </header>

        <!-- ძირითადი სამუშაო არე -->
        <div class="exam-body">
          <!-- კითხვის ძირითადი ბლოკი -->
          <main class="question-main">
            <div class="question-top-bar">
              <div class="chapter-info">
                <span class="chapter-title" id="qChapterName">...</span>
                <span class="subchapter-title" id="qSubchapterName">...</span>
              </div>
              <div class="flag-action">
                <button id="flagBtn" class="btn-flag">
                  <span class="flag-star">★</span> <span id="flagText">მონიშვნა გადასახედად</span>
                </button>
              </div>
            </div>

            <div class="question-card" id="questionCard"></div>

            <div class="question-navigation">
              <button id="prevBtn" class="btn btn-secondary">« წინა კითხვა</button>
              <div class="nav-question-counter" id="navCounter">1 / 100</div>
              <button id="nextBtn" class="btn btn-primary">შემდეგი კითხვა »</button>
            </div>
          </main>

          <!-- მარჯვენა სანავიგაციო პალიტრა (1..100) -->
          <aside class="palette-sidebar">
            <div class="palette-header">
              <h3>კითხვების ბადე (100)</h3>
              <div class="palette-filters">
                <button class="p-filter active" data-filter="all">ყველა (<span id="countAll">100</span>)</button>
                <button class="p-filter" data-filter="unanswered">გაუცემელი (<span id="countUnanswered">100</span>)</button>
                <button class="p-filter" data-filter="flagged">მონიშნული (<span id="countFlagged">0</span>)</button>
              </div>
            </div>

            <div class="palette-grid" id="paletteGrid"></div>

            <div class="palette-legend">
              <div class="leg-item"><span class="leg-box active"></span> მიმდინარე</div>
              <div class="leg-item"><span class="leg-box answered"></span> პასუხგაცემული</div>
              <div class="leg-item"><span class="leg-box flagged"></span> მონიშნული (★)</div>
              <div class="leg-item"><span class="leg-box unans"></span> გაუცემელი</div>
            </div>
          </aside>
        </div>
      </div>
    `;

    // კალკულატორის გახსნა
    const docsBtn = document.getElementById('docsToggleBtn');
    if (docsBtn) {
      docsBtn.addEventListener('click', () => this.renderDocsModal());
    }
    const calcBtn = document.getElementById('calcToggleBtn');
    if (calcBtn) {
      calcBtn.addEventListener('click', () => this.calculator.toggle());
    }

    // შენახვა და გასვლა (სასწავლო რეჟიმისთვის)
    const pauseBtn = document.getElementById('pauseStudyBtn');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => {
        this.saveStudyProgress();
        alert("💾 თქვენი სასწავლო პროგრესი შენახულია!\n\nშეგიძლიათ მშვიდად განაგრძოთ მუშაობა და დაბრუნდეთ ნებისმიერ დროს (თუნდაც ხვალ) — სისტემა გაგიხსნით ზუსტად იმავე კითხვას.");
        this.renderHome();
      });
    }

    // დასრულება
    document.getElementById('finishExamBtn').addEventListener('click', () => {
      this.promptFinishExam();
    });

    // ნავიგაცია
    document.getElementById('prevBtn').addEventListener('click', () => {
      if (exam.currentIndex > 0) {
        exam.currentIndex--;
        if (exam.mode === 'study') this.saveStudyProgress();
        this.renderCurrentQuestion();
        this.updatePalette();
      }
    });

    document.getElementById('nextBtn').addEventListener('click', () => {
      if (exam.currentIndex < exam.questions.length - 1) {
        exam.currentIndex++;
        if (exam.mode === 'study') this.saveStudyProgress();
        this.renderCurrentQuestion();
        this.updatePalette();
      }
    });

    // დროშა
    document.getElementById('flagBtn').addEventListener('click', () => {
      this.engine.toggleFlag(exam.currentIndex);
      if (exam.mode === 'study') this.saveStudyProgress();
      this.renderCurrentQuestion();
      this.updatePalette();
    });

    // ფილტრები
    document.querySelectorAll('.p-filter').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.p-filter').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        this.currentFilter = e.currentTarget.getAttribute('data-filter');
        this.updatePalette();
      });
    });

    // კლავიატურის ნავიგაცია (ისრები, 1-4, F)
    this.setupKeyboardShortcuts();

    this.renderCurrentQuestion();
    this.updatePalette();
  }

  setupKeyboardShortcuts() {
    if (this.keyHandlerBound) {
      window.removeEventListener('keydown', this.keyHandlerBound);
    }

    this.keyHandlerBound = (e) => {
      const exam = this.engine.currentExam;
      if (!exam || exam.isFinished) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowLeft') {
        if (exam.currentIndex > 0) {
          exam.currentIndex--;
          this.renderCurrentQuestion();
          this.updatePalette();
        }
      } else if (e.key === 'ArrowRight') {
        if (exam.currentIndex < exam.questions.length - 1) {
          exam.currentIndex++;
          this.renderCurrentQuestion();
          this.updatePalette();
        }
      } else if (e.key === 'f' || e.key === 'F') {
        this.engine.toggleFlag(exam.currentIndex);
        this.renderCurrentQuestion();
        this.updatePalette();
      } else if (['1', '2', '3', '4'].includes(e.key)) {
        const optIdx = parseInt(e.key, 10) - 1;
        this.engine.selectAnswer(exam.currentIndex, optIdx);
        this.renderCurrentQuestion();
        this.updatePalette();
      }
    };

    window.addEventListener('keydown', this.keyHandlerBound);
  }

  renderCurrentQuestion() {
    const exam = this.engine.currentExam;
    const q = exam.questions[exam.currentIndex];
    if (!q) return;

    document.getElementById('qChapterName').innerText = q.chapterName || '';
    document.getElementById('qSubchapterName').innerText = q.subchapterName || '';
    document.getElementById('navCounter').innerText = `${exam.currentIndex + 1} / ${exam.questions.length}`;

    document.getElementById('prevBtn').disabled = (exam.currentIndex === 0);
    document.getElementById('nextBtn').disabled = (exam.currentIndex === exam.questions.length - 1);

    const isFlagged = exam.flagged.has(exam.currentIndex);
    const flagBtn = document.getElementById('flagBtn');
    if (isFlagged) {
      flagBtn.classList.add('active');
      document.getElementById('flagText').innerText = "მონიშნულია გადასახედად";
    } else {
      flagBtn.classList.remove('active');
      document.getElementById('flagText').innerText = "მონიშვნა გადასახედად";
    }

    const card = document.getElementById('questionCard');
    const reqChoices = q.required_choices || 1;
    const userAnswers = exam.userAnswers[exam.currentIndex] || [];
    const isAnswered = userAnswers.length > 0;

    card.innerHTML = `
      <div class="q-meta-row">
        <span class="q-number-pill">კითხვა №${exam.currentIndex + 1} / ${exam.questions.length}</span>
        <span class="q-code-pill" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;padding:3px 8px;border-radius:4px;font-weight:700;font-size:12px;">კოდი ${q.code || (79000 + exam.currentIndex + 1)}</span>
        <span class="q-diff-pill ${q.difficulty || exam.difficulty || 'easy'}">
          ${(q.difficulty === 'hard' || exam.difficulty === 'hard') ? '🔴 რთული კაზუსი' : ((q.difficulty === 'medium' || exam.difficulty === 'medium') ? '🟡 საშუალო' : '🟢 მარტივი')}
        </span>
        <span class="q-required-pill ${reqChoices > 1 ? 'multi' : 'single'}">
          ${reqChoices > 1 ? `⚠️ აირჩიეთ ${reqChoices} სწორი პასუხი` : `აირჩიეთ 1 სწორი პასუხი`}
        </span>
        <span class="q-ref-pill">${q.reference || ''}</span>
      </div>

      <div class="q-text">${this.formatMath(q.question)}</div>

      <div class="q-options-list">
        ${q.options.map((opt, optIdx) => {
          const isSelected = userAnswers.includes(optIdx);
          let extraClass = '';
          if (exam.mode === 'study' && isAnswered) {
            if (q.correct.includes(optIdx)) extraClass = ' study-correct';
            else if (isSelected) extraClass = ' study-wrong';
          }

          return `
            <div class="q-option ${isSelected ? 'selected' : ''}${extraClass}" data-opt="${optIdx}">
              <div class="opt-indicator ${reqChoices > 1 ? 'checkbox' : 'radio'}">
                ${isSelected ? (reqChoices > 1 ? '✔' : '●') : ''}
              </div>
              <div class="opt-label">${String.fromCharCode(65 + optIdx)}.</div>
              <div class="opt-content">${this.formatMath(opt)}</div>
            </div>
          `;
        }).join('')}
      </div>

      ${(exam.mode === 'study' && isAnswered) ? (() => {
        const isCorrect = q.correct.length === userAnswers.length && q.correct.every(c => userAnswers.includes(c));
        const correctLabels = q.correct.map(c => `<strong>${String.fromCharCode(65 + c)}.</strong> ${this.formatMath(q.options[c])}`).join('<br>');
        return `
          <div class="study-explanation-box ${isCorrect ? 'correct-box' : 'wrong-box'}">
            <div class="study-status-banner ${isCorrect ? 'status-correct' : 'status-wrong'}">
              <span style="font-size:18px;">${isCorrect ? '✅' : '❌'}</span>
              <span>${isCorrect ? 'თქვენი პასუხი სწორია!' : 'თქვენი პასუხი არასწორია!'}</span>
            </div>

            <div style="margin-bottom:12px;background:#ffffff;padding:10px 14px;border-radius:6px;border:1px solid ${isCorrect ? '#86efac' : '#fca5a5'};">
              <div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:4px;">სწორი პასუხი:</div>
              <div style="font-size:13.5px;color:#0f172a;line-height:1.45;">${correctLabels}</div>
            </div>

            <div class="study-section">
              <div class="study-section-title">📖 ვრცელი ნორმატიული და სამართლებრივი განმარტება:</div>
              <div class="study-text">${this.formatExtendedExplanation(q, userAnswers)}</div>
            </div>

            <div class="study-meta-grid">
              <div class="study-meta-item">
                <span class="meta-label">📜 სამართლებრივი მითითება / აქტი:</span>
                <span class="meta-val">${this.escapeHtml(q.reference || 'საქართველოს მოქმედი სამშენებლო ნორმები')}</span>
              </div>
              <div class="study-meta-item">
                <span class="meta-label">📂 საგამოცდო ქვეთავი:</span>
                <span class="meta-val">${this.escapeHtml(q.subchapterName || q.chapterName || 'დადგენილება №134')}</span>
              </div>
            </div>

            <div class="study-pro-tip">
              <span style="font-size:18px;">💡</span>
              <div>
                <strong>საგამოცდო რჩევა:</strong> დააკვირდით კითხვაში მოცემულ საკვანძო ტერმინებსა და რიცხვით პარამეტრებს. გამოცდაზე მსგავსი კითხვები ხშირად ამოწმებს გამონაკლისებსა და კლასების მიხედვით დაწესებულ ზღვრულ მოთხოვნებს.
              </div>
            </div>
          </div>
        `;
      })() : ''}
    `;

    // ვარიანტის არჩევა
    card.querySelectorAll('.q-option').forEach(el => {
      el.addEventListener('click', () => {
        const optIdx = parseInt(el.getAttribute('data-opt'), 10);
        this.engine.selectAnswer(exam.currentIndex, optIdx);
        if (exam.mode === 'study') {
          this.saveStudyProgress();
        }
        this.renderCurrentQuestion();
        this.updatePalette();
      });
    });
  }

  updatePalette() {
    const exam = this.engine.currentExam;
    const grid = document.getElementById('paletteGrid');
    if (!grid) return;

    let unansweredCount = 0;
    let answeredCount = 0;
    let flaggedCount = exam.flagged.size;

    exam.questions.forEach((q, idx) => {
      const ans = exam.userAnswers[idx];
      if (ans && ans.length > 0) {
        answeredCount++;
      } else {
        unansweredCount++;
      }
    });

    document.getElementById('countAll').innerText = exam.questions.length;
    document.getElementById('countUnanswered').innerText = unansweredCount;
    document.getElementById('countFlagged').innerText = flaggedCount;

    grid.innerHTML = exam.questions.map((q, idx) => {
      const isAns = (exam.userAnswers[idx] && exam.userAnswers[idx].length > 0);
      const isFlg = exam.flagged.has(idx);
      const isCur = (idx === exam.currentIndex);

      if (this.currentFilter === 'unanswered' && isAns) return '';
      if (this.currentFilter === 'flagged' && !isFlg) return '';

      let classes = ['p-item'];
      if (isCur) classes.push('current');
      if (isAns) classes.push('answered');
      if (isFlg) classes.push('flagged');

      return `
        <button class="${classes.join(' ')}" data-idx="${idx}" title="კითხვა №${idx + 1}">
          ${idx + 1}
          ${isFlg ? '<span class="mini-flag">★</span>' : ''}
        </button>
      `;
    }).join('');

    grid.querySelectorAll('.p-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        exam.currentIndex = idx;
        if (exam.mode === 'study') this.saveStudyProgress();
        this.renderCurrentQuestion();
        this.updatePalette();
      });
    });
  }

  updateTimerDisplay(totalSeconds) {
    const digits = document.getElementById('timerDigits');
    const box = document.getElementById('timerBox');
    if (!digits || !box) return;

    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    digits.innerText = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    if (totalSeconds < 300) {
      box.className = 'timer-box danger';
    } else if (totalSeconds < 900) {
      box.className = 'timer-box warning';
    } else {
      box.className = 'timer-box';
    }
  }

  promptFinishExam() {
    const exam = this.engine.currentExam;
    let unanswered = 0;
    exam.questions.forEach((q, i) => {
      if (!exam.userAnswers[i] || exam.userAnswers[i].length === 0) unanswered++;
    });

    let msg = exam.mode === 'study'
      ? "გსურთ სასწავლო სესიის შეჯამება და შედეგების ნახვა?"
      : "ნამდვილად გსურთ გამოცდის დასრულება და ნაშრომის გადაგზავნა?";

    if (unanswered > 0) {
      msg = `ყურადღება! თქვენ გაქვთ ${unanswered} გაუცემელი პასუხი 100-დან.\n\n` + msg;
    }

    if (confirm(msg)) {
      if (exam.mode === 'study') {
        this.clearSavedStudyProgress(exam.profileId);
      }
      this.engine.finishExam();
      this.renderResults();
    }
  }

  getCloudApiUrl() {
    return 'https://api.restful-api.dev/objects/ff808181a09d98f701a1a5e052fe2e39';
  }

  getBackupStreamUrl() {
    return 'https://ntfy.sh/georgia_exam_journal_64c77fc8';
  }

  mergeEntries(listA, listB) {
    const map = new Map();
    [...(listA || []), ...(listB || [])].forEach(item => {
      if (item && item.id) {
        map.set(item.id, item);
      }
    });
    return Array.from(map.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  getApiBaseUrl() {
    // თუ სერვერიდან ეშვება, ვიყენებთ ფარდობით მისამართს
    if (window.location.protocol.startsWith('http')) {
      return window.location.origin;
    }
    return 'http://localhost:3000';
  }

  async syncFromCloud() {
    try {
      // 1. ჯერ ვცდილობთ ჩვენს ცენტრალურ სერვერს
      const serverResp = await fetch(`${this.getApiBaseUrl()}/api/admin/journal?pin=${encodeURIComponent(this.getAdminPin())}`, { cache: 'no-store' });
      if (serverResp.ok) {
        const data = await serverResp.json();
        if (data && Array.isArray(data.submissions)) {
          localStorage.setItem('exam_results_journal', JSON.stringify(data.submissions));
          if (data.adminPin) {
            localStorage.setItem('exam_admin_pin', String(data.adminPin));
          }
          return data.submissions;
        }
      }
    } catch (e) {
      // თუ სერვერზე პირდაპირი წვდომა არ არის, გადავდივართ სარეზერვო ღრუბელზე
    }

    try {
      const resp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
      if (resp.ok) {
        const obj = await resp.json();
        const cloudEntries = (obj && obj.data && Array.isArray(obj.data.entries)) ? obj.data.entries : [];
        if (obj && obj.data && obj.data.adminPin) {
          localStorage.setItem('exam_admin_pin', String(obj.data.adminPin));
        }
        if (obj && obj.data && obj.data.googleClientId) {
          localStorage.setItem('exam_google_client_id', String(obj.data.googleClientId));
        }
        if (obj && obj.data && obj.data.accounts && typeof obj.data.accounts === 'object') {
          localStorage.setItem('exam_cloud_accounts_cache', JSON.stringify(obj.data.accounts));
        }
        const localEntries = JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
        const merged = this.mergeEntries(cloudEntries, localEntries);
        localStorage.setItem('exam_results_journal', JSON.stringify(merged));
        return merged;
      }
    } catch (e) {
      console.warn('Cloud sync read notice:', e);
    }
    return JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
  }

  async pushToCloud(newEntry, clearAll = false, forceNewPin = null, forceGoogleClientId = null) {
    // 1. პირველ რიგში ვგზავნით ჩვენს ცენტრალურ Node სერვერზე
    if (newEntry) {
      try {
        fetch(`${this.getApiBaseUrl()}/api/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(newEntry)
        }).catch(() => {});
      } catch (err) {}
    }

    if (clearAll) {
      try {
        fetch(`${this.getApiBaseUrl()}/api/admin/clear-journal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ pin: this.getAdminPin() })
        }).catch(() => {});
      } catch (err) {}
    }

    if (forceNewPin) {
      try {
        fetch(`${this.getApiBaseUrl()}/api/admin/change-pin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ oldPin: this.getAdminPin(), newPin: forceNewPin })
        }).catch(() => {});
      } catch (err) {}
    }

    // 2. პარალელურად სარეზერვო ღრუბელში
    try {
      let currentCloud = [];
      let currentAccounts = this.getLocalAccounts();
      let cloudPin = forceNewPin ? String(forceNewPin) : this.getAdminPin();
      let cloudGoogleClientId = forceGoogleClientId ? String(forceGoogleClientId) : this.getGoogleClientId();

      if (!clearAll) {
        try {
          const getResp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
          if (getResp.ok) {
            const obj = await getResp.json();
            if (obj && obj.data) {
              if (Array.isArray(obj.data.entries)) currentCloud = obj.data.entries;
              if (obj.data.accounts && typeof obj.data.accounts === 'object') {
                Object.assign(currentAccounts, obj.data.accounts);
              }
              if (!forceNewPin && obj.data.adminPin) {
                cloudPin = String(obj.data.adminPin);
                localStorage.setItem('exam_admin_pin', cloudPin);
              }
              if (!forceGoogleClientId && obj.data.googleClientId) {
                cloudGoogleClientId = String(obj.data.googleClientId);
                localStorage.setItem('exam_google_client_id', cloudGoogleClientId);
              }
            }
          }
        } catch (err) {}
      } else {
        // თუ ჟურნალი იწმინდება, ანგარიშები მაინც უნდა შევინარჩუნოთ!
        try {
          const getResp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
          if (getResp.ok) {
            const obj = await getResp.json();
            if (obj && obj.data && obj.data.accounts && typeof obj.data.accounts === 'object') {
              Object.assign(currentAccounts, obj.data.accounts);
            }
          }
        } catch (err) {}
      }

      const localEntries = clearAll ? [] : JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
      const combined = clearAll
        ? []
        : this.mergeEntries(newEntry ? [newEntry, ...localEntries] : localEntries, currentCloud).slice(0, 500);

      localStorage.setItem('exam_results_journal', JSON.stringify(combined));

      await fetch(this.getCloudApiUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          name: 'georgia_exam_journal_v1',
          data: {
            entries: combined,
            accounts: currentAccounts,
            adminPin: cloudPin,
            googleClientId: cloudGoogleClientId,
            updatedAt: Date.now()
          }
        })
      });

      if (newEntry && !clearAll) {
        fetch(this.getBackupStreamUrl(), {
          method: 'POST',
          body: JSON.stringify(newEntry)
        }).catch(() => {});
      }
    } catch (e) {
      console.warn('Cloud push notice:', e);
    }
  }

  recordSubmission(res, scorePercent) {
    try {
      const journal = JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
      const now = new Date();
      const dateFormatted = now.toLocaleDateString('ka-GE') + ' ' + now.toLocaleTimeString('ka-GE');

      const entry = {
        id: 'EX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 3).toUpperCase(),
        date: dateFormatted,
        timestamp: now.getTime(),
        candidateName: this.candidate ? this.candidate.name : 'ანონიმი კანდიდატი',
        candidateEmail: this.candidate ? this.candidate.email : 'არ არის მითითებული',
        candidatePhone: this.candidate ? (this.candidate.phone || '') : '',
        profileId: res.profileId,
        profileTitle: res.profileTitle,
        difficulty: this.engine.currentExam.difficulty || 'easy',
        difficultyTitle: this.engine.currentExam.difficultyTitle || (this.engine.currentExam.difficulty === 'hard' ? 'რთული' : (this.engine.currentExam.difficulty === 'medium' ? 'საშუალო' : 'მარტივი')),
        mode: this.engine.currentExam.mode === 'exam' ? 'საგამოცდო' : 'სასწავლო',
        score: res.totalEarned,
        total: res.totalQuestions,
        percent: scorePercent,
        passed: res.finalPassed,
        timeSpentMinutes: Math.floor(res.timeSpentSeconds / 60),
        subStats: res.subStats.filter(st => st.total > 0).map(st => ({
          name: st.name,
          chapterName: st.chapterName,
          correct: st.correct,
          total: st.total,
          percent: (st.score * 100).toFixed(0),
          passed: st.passed
        }))
      };

      journal.unshift(entry);
      localStorage.setItem('exam_results_journal', JSON.stringify(journal));

      // 1. ავტომატური ჩაწერა ცენტრალურ ღრუბლოვან ბაზაში (ნებისმიერი მოწყობილობიდან სანახავად)
      this.pushToCloud(entry, false);

      // 2. Google Apps Script-ში პირდაპირი შენახვა (თუ გაშვებულია GAS გარემოში)
      if (typeof google !== 'undefined' && google.script && google.script.run) {
        google.script.run
          .withSuccessHandler(function(resp) {
            console.log("ქულა წარმატებით ჩაიწერა Google Sheet-ში!", resp);
          })
          .withFailureHandler(function(err) {
            console.error("Google Sheet შეცდომა:", err);
          })
          .saveExamResult(entry);
      }

      // 3. თუ დამატებით მითითებულია Webhook URL, ფონურად ვაგზავნით
      const webhookUrl = localStorage.getItem('exam_webhook_url');
      if (webhookUrl && webhookUrl.startsWith('http')) {
        fetch(webhookUrl, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry)
        }).catch(err => console.log('Webhook log notice:', err));
      }
    } catch (e) {
      console.warn("შედეგის შენახვის შეცდომა:", e);
    }
  }

  renderResults() {
    if (this.keyHandlerBound) {
      window.removeEventListener('keydown', this.keyHandlerBound);
      this.keyHandlerBound = null;
    }

    const res = this.engine.currentExam.result;
    const app = document.getElementById('app');

    const scorePercent = (res.overallScore * 100).toFixed(1);
    const thresholdPercent = (res.threshold * 100).toFixed(0);

    // შედეგის ავტომატური რეგისტრაცია ჟურნალში
    this.recordSubmission(res, scorePercent);

    app.innerHTML = `
      <div class="results-container">
        <header class="results-header">
          <div class="result-banner ${res.finalPassed ? 'passed' : 'failed'}">
            <div class="banner-icon">${res.finalPassed ? '✅' : '❌'}</div>
            <div class="banner-text">
              <h2>${res.finalPassed ? 'გამოცდა წარმატებით ჩაბარებულია!' : 'გამოცდა ვერ ჩაბარდა'}</h2>
              <p class="banner-sub">
                ${res.finalPassed 
                  ? `გილოცავთ! თქვენ გადალახეთ ${thresholdPercent}%-იანი ბარიერი როგორც საერთო ქულით, ისე ყველა ქვეთავში დამოუკიდებლად.` 
                  : (res.overallPassed && !res.allSubchaptersPassed 
                      ? `ყურადღება: თქვენი საერთო ქულაა ${scorePercent}% (≥ ${thresholdPercent}%), მაგრამ გამოცდა ჩაჭრილია №134 დადგენილების ქვეთავობრივი ჩაჭრის წესით!` 
                      : `თქვენ ვერ გადალახეთ საგამოცდო ბარიერი (საჭიროა მინიმუმ ${thresholdPercent}%).`)}
              </p>
            </div>
          </div>
        </header>

        <section class="results-stats-cards">
          <div class="stat-card">
            <span class="stat-label">კანდიდატი:</span>
            <span class="stat-value small">${this.candidate ? this.escapeHtml(this.candidate.name) : 'ანონიმი'}</span>
            <span class="stat-foot">${this.candidate ? this.escapeHtml(this.candidate.email) : ''}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">საგამოცდო პროფილი:</span>
            <span class="stat-value small">${res.profileTitle}</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">სირთულის დონე:</span>
            <span class="stat-value small">
              <span class="diff-badge ${this.engine.currentExam.difficulty || 'easy'}">
                ${this.engine.currentExam.difficultyTitle || 'მარტივი'}
              </span>
            </span>
          </div>
          <div class="stat-card">
            <span class="stat-label">საერთო ქულა:</span>
            <span class="stat-value ${res.finalPassed ? 'pass' : 'fail'}">${scorePercent}%</span>
            <span class="stat-foot">${res.totalEarned} / ${res.totalQuestions} სწორი პასუხი</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">ქვეთავობრივი ბარიერი:</span>
            <span class="stat-value">≥ ${thresholdPercent}%</span>
            <span class="stat-foot">თითოეულ ქვეთავში ცალ-ცალკე</span>
          </div>
          <div class="stat-card">
            <span class="stat-label">დახარჯული დრო:</span>
            <span class="stat-value small">${Math.floor(res.timeSpentSeconds / 60)} წუთი</span>
          </div>
        </section>

        <!-- ქვეთავების შეფასების უწყისი -->
        <section class="subchapters-breakdown-section">
          <h3>საგამოცდო ქვეთავების ოფიციალური შეფასების უწყისი (დადგენილება №134):</h3>
          <p class="section-desc">გამოცდის ჩასაბარებლად აუცილებელია თითოეულ ქვეთავში მინიმუმ ${thresholdPercent}%-ის მიღება.</p>

          <div class="sub-table-wrap">
            <table class="sub-table">
              <thead>
                <tr>
                  <th>საგამოცდო ქვეთავი / თემატიკა</th>
                  <th>კითხვები</th>
                  <th>სწორი</th>
                  <th>მიღებული %</th>
                  <th>ზღვარი</th>
                  <th>სტატუსი</th>
                </tr>
              </thead>
              <tbody>
                ${res.subStats.filter(st => st.total > 0).map(st => {
                  const pct = (st.score * 100).toFixed(0);
                  return `
                    <tr class="${st.passed ? 'row-pass' : 'row-fail'}">
                      <td>
                        <div class="sub-ch-name">${st.name}</div>
                        <div class="sub-ch-parent">${st.chapterName}</div>
                      </td>
                      <td>${st.total}</td>
                      <td><strong>${st.correct}</strong></td>
                      <td>
                        <div class="table-progress">
                          <div class="bar ${st.passed ? 'pass' : 'fail'}" style="width: ${pct}%"></div>
                          <span class="bar-txt">${pct}%</span>
                        </div>
                      </td>
                      <td>${thresholdPercent}%</td>
                      <td>
                        <span class="status-tag ${st.passed ? 'pass' : 'fail'}">
                          ${st.passed ? 'ჩაბარებულია' : 'ჩაჭრილია!'}
                        </span>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <!-- კითხვების განხილვა -->
        <section class="questions-review-section">
          <div class="review-header-row">
            <h3>კითხვების დეტალური განხილვა და ნორმატიული ანალიზი:</h3>
            <div class="review-filter-buttons">
              <button class="btn btn-sm btn-outline rev-filter-btn active" data-filter="all">ყველა კითხვა (100)</button>
              <button class="btn btn-sm btn-outline rev-filter-btn" data-filter="errors">მხოლოდ შეცდომები (${res.totalQuestions - res.totalEarned})</button>
            </div>
          </div>

          <div class="review-questions-list" id="reviewQuestionsList">
            ${this.renderReviewQuestionsList(res.evaluatedQuestions, 'all')}
          </div>
        </section>

        <footer class="results-footer">
          <button id="btnRestartExam" class="btn btn-primary btn-lg">ახალი გამოცდის დაწყება (ახალი კითხვებით)</button>
          <button id="btnReturnHome" class="btn btn-secondary btn-lg">მთავარ გვერდზე დაბრუნება</button>
        </footer>
      </div>
    `;

    // ფილტრაცია განხილვაში
    app.querySelectorAll('.rev-filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        app.querySelectorAll('.rev-filter-btn').forEach(b => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const filter = e.currentTarget.getAttribute('data-filter');
        document.getElementById('reviewQuestionsList').innerHTML = this.renderReviewQuestionsList(res.evaluatedQuestions, filter);
      });
    });

    document.getElementById('btnRestartExam').addEventListener('click', () => {
      const profileId = this.engine.currentExam.profile.id;
      const mode = this.engine.currentExam.mode;
      this.startTest(profileId, mode);
    });

    document.getElementById('btnReturnHome').addEventListener('click', () => {
      this.renderHome();
    });
  }

  renderReviewQuestionsList(questions, filter) {
    return questions.map((q, i) => {
      if (filter === 'errors' && q.isCorrect) return '';

      return `
        <div class="rev-card ${q.isCorrect ? 'rev-correct' : 'rev-wrong'}">
          <div class="rev-header">
            <span class="rev-num">კითხვა №${i + 1}</span>
            <span class="rev-status">${q.isCorrect ? '✅ სწორია (+1 ქულა)' : '❌ შეცდომა (0 ქულა)'}</span>
            <span class="rev-ref">${q.reference || ''}</span>
          </div>
          <div class="rev-text">${this.formatMath(q.question)}</div>
          <div class="rev-options">
            ${q.options.map((opt, optIdx) => {
              const isUser = q.userSelection.includes(optIdx);
              const isCorr = q.correctSelection.includes(optIdx);
              let optClass = '';
              if (isCorr) optClass = 'opt-corr-answer';
              if (isUser && !isCorr) optClass = 'opt-wrong-answer';
              return `
                <div class="rev-opt ${optClass}">
                  <span class="rev-opt-check">
                    ${isCorr ? '✓' : (isUser ? '✗' : '○')}
                  </span>
                  <span>${String.fromCharCode(65 + optIdx)}. ${this.formatMath(opt)}</span>
                  ${isUser ? '<span class="your-choice-tag">თქვენი პასუხი</span>' : ''}
                  ${isCorr ? '<span class="correct-choice-tag">სწორი პასუხი</span>' : ''}
                </div>
              `;
            }).join('')}
          </div>
          <div class="rev-explanation">
            <strong>სამართლებრივი საფუძველი:</strong> ${q.explanation}
          </div>
        </div>
      `;
    }).join('');
  }

  // ==========================================================================
  // ადმინისტრატორის მართვის პანელი (Admin Dashboard)
  // ==========================================================================

  renderAdminPanel(skipCloudSync = false) {
    if (this.keyHandlerBound) {
      window.removeEventListener('keydown', this.keyHandlerBound);
      this.keyHandlerBound = null;
    }

    const app = document.getElementById('app');
    const journal = JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
    const currentPin = this.getAdminPin();

    // უნიკალური კანდიდატების განსაზღვრა საგამოცდო უწყისიდან
    const candidateMap = new Map();
    journal.forEach(j => {
      const key = (j.candidateEmail || j.candidateName || '').trim().toLowerCase();
      if (!key) return;
      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          name: j.candidateName || 'უცნობი',
          email: j.candidateEmail || '—',
          phone: j.candidatePhone || '—',
          count: 0,
          lastDate: j.date || '—'
        });
      }
      candidateMap.get(key).count += 1;
    });
    const uniqueCandidates = Array.from(candidateMap.values());

    // თუ პირველად იხსნება პანელი, ფონურად წამოვიღოთ ღრუბლოვანი ბაზიდან ყველა მოწყობილობის შედეგები
    if (!skipCloudSync) {
      this.syncFromCloud().then(() => {
        if (document.querySelector('.admin-container')) {
          this.renderAdminPanel(true);
        }
      });
    }

    // სტატისტიკის დათვლა
    const totalTests = journal.length;
    const passedTests = journal.filter(j => j.passed).length;
    const passRate = totalTests > 0 ? ((passedTests / totalTests) * 100).toFixed(0) : 0;
    const avgScore = totalTests > 0 ? (journal.reduce((sum, j) => sum + (parseFloat(j.percent) || 0), 0) / totalTests).toFixed(1) : 0;

    app.innerHTML = `
      <div class="admin-container">
        <div class="admin-header-row">
          <h1>🔐 ადმინისტრატორის მართვის პანელი • შედეგების ერთიანი ონლაინ ჟურნალი</h1>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="btn btn-primary" id="btnRefreshCloud">🔄 ღრუბლიდან განახლება</button>
            <button class="btn btn-secondary" id="btnAdminBackHome">← მთავარ გვერდზე დაბრუნება</button>
          </div>
        </div>

        <!-- KPI ბარათები -->
        <div class="admin-kpi-grid">
          <div class="admin-kpi-card">
            <span class="kpi-label">სულ გავლილი ტესტები (ყველა მოწყობილობაზე)</span>
            <span class="kpi-value">${totalTests}</span>
            <span class="kpi-foot">დაფიქსირებული სესიები</span>
          </div>
          <div class="admin-kpi-card">
            <span class="kpi-label">ჩაბარების მაჩვენებელი</span>
            <span class="kpi-value" style="color:#059669;">${passRate}%</span>
            <span class="kpi-foot">${passedTests} წარმატებული / ${totalTests - passedTests} ჩაჭრილი</span>
          </div>
          <div class="admin-kpi-card">
            <span class="kpi-label">საშუალო ქულა</span>
            <span class="kpi-value" style="color:#2563eb;">${avgScore}%</span>
            <span class="kpi-foot">ყველა კანდიდატის საერთო საშუალო</span>
          </div>
        </div>

        <!-- პარამეტრების ბარათი -->
        <div class="admin-settings-card">
          <div class="admin-settings-grid">
            <div>
              <h3 style="font-size:16px;margin-bottom:12px;color:#1e293b;">🔑 ადმინისტრატორის საიდუმლო პაროლის შეცვლა</h3>
              <p style="font-size:13px;color:#64748b;margin-bottom:12px;">
                სტატუსი: <strong>•••••••• (კონფიდენციალურად დაცულია ღრუბლოვან ბაზაში)</strong>
              </p>
              <div style="display:flex;gap:8px;">
                <input type="password" id="newPinInput" class="form-input" placeholder="ახალი საიდუმლო პაროლი" style="max-width:220px;">
                <button class="btn btn-primary" id="btnSaveNewPin">შენახვა</button>
              </div>
            </div>

            <div>
              <h3 style="font-size:16px;margin-bottom:12px;color:#1e293b;">☁️ ავტომატური ღრუბლოვანი სინქრონიზაცია</h3>
              <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:12px 16px;color:#065f46;font-size:13.5px;line-height:1.5;">
                <strong>✅ ონლაინ ბაზა აქტიურია (კონფიგურაცია არ სჭირდება):</strong><br>
                ნებისმიერი კომპიუტერიდან ან ტელეფონიდან კანდიდატის მიერ ჩაბარებული ტესტის ქულა და ქვეთავობრივი დეტალები <strong>ავტომატურად იგზავნება ღრუბლოვან ბაზაში</strong> და პირდაპირ ჩანს ამ ცხრილში. შეგიძლიათ ნებისმიერ დროს ჩამოტვირთოთ Excel (CSV) ფაილად.
              </div>
            </div>
          </div>
        </div>

        <!-- მოქმედებების ზოლი -->
        <div class="admin-tools-row">
          <h2 style="font-size:18px;font-weight:700;color:#1e293b;">კანდიდატების საგამოცდო უწყისი (${totalTests}):</h2>
          <div class="admin-actions-group">
            <button class="btn-export-excel" id="btnExportExcel">
              📥 ექსპორტი Excel-ში (CSV)
            </button>
            <button class="btn-danger-outline" id="btnClearJournal">
              🗑️ ჟურნალის გასუფთავება
            </button>
          </div>
        </div>

        <!-- შედეგების ცხრილი -->
        <div class="journal-table-wrap">
          <table class="journal-table">
            <thead>
              <tr>
                <th>#</th>
                <th>თარიღი / დრო</th>
                <th>კანდიდატი</th>
                <th>Gmail მისამართი</th>
                <th>პროფილი</th>
                <th>სირთულე</th>
                <th>რეჟიმი</th>
                <th>ქულა / 100</th>
                <th>სტატუსი</th>
                <th>დრო</th>
                <th>დეტალები</th>
              </tr>
            </thead>
            <tbody>
              ${journal.length === 0 ? `
                <tr>
                  <td colspan="11" style="text-align:center;padding:40px;color:#64748b;">
                    საგამოცდო ჟურნალი ცარიელია. შედეგები ავტომატურად გამოჩნდება ტესტების ჩაბარებისთანავე.
                  </td>
                </tr>
              ` : journal.map((row, idx) => `
                <tr>
                  <td><strong>${journal.length - idx}</strong></td>
                  <td style="white-space:nowrap;">${row.date}</td>
                  <td><strong>${this.escapeHtml(row.candidateName)}</strong></td>
                  <td><a href="mailto:${this.escapeHtml(row.candidateEmail)}" style="color:#2563eb;text-decoration:none;">${this.escapeHtml(row.candidateEmail)}</a></td>
                  <td>${this.escapeHtml(row.profileTitle)}</td>
                  <td><span class="badge diff-badge-sm ${row.difficulty || 'easy'}">${row.difficultyTitle || (row.difficulty === 'hard' ? '🔴 რთული' : (row.difficulty === 'medium' ? '🟡 საშუალო' : '🟢 მარტივი'))}</span></td>
                  <td><span class="badge ${row.mode === 'საგამოცდო' ? 'exam' : 'study'}">${row.mode}</span></td>
                  <td><strong>${row.score} / ${row.total}</strong> (${row.percent}%)</td>
                  <td>
                    <span class="tag-status ${row.passed ? 'pass' : 'fail'}">
                      ${row.passed ? 'ჩაბარებულია' : 'ჩაჭრილია'}
                    </span>
                  </td>
                  <td>${row.timeSpentMinutes} წთ</td>
                  <td>
                    <button class="btn btn-sm btn-subtle view-details-btn" data-idx="${idx}">ნახვა</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        <!-- უნიკალური კანდიდატების სია საგამოცდო უწყისიდან -->
        <div class="admin-tools-row" style="margin-top:34px;">
          <h2 style="font-size:18px;font-weight:700;color:#1e293b;">👥 გამოცდაზე გასული კანდიდატები (${uniqueCandidates.length}):</h2>
        </div>

        <div class="journal-table-wrap">
          <table class="journal-table">
            <thead>
              <tr>
                <th>#</th>
                <th>სახელი და გვარი</th>
                <th>პირადი ნომერი / Gmail</th>
                <th>ტელეფონი</th>
                <th>ტესტების რაოდენობა</th>
                <th>ბოლო აქტივობა</th>
              </tr>
            </thead>
            <tbody>
              ${uniqueCandidates.length === 0 ? `
                <tr>
                  <td colspan="6" style="text-align:center;padding:26px;color:#64748b;">
                    კანდიდატების ჩანაწერები ჯერ არ ფიქსირდება.
                  </td>
                </tr>
              ` : uniqueCandidates.map((u, idx) => `
                <tr>
                  <td><strong>${idx + 1}</strong></td>
                  <td><strong>${this.escapeHtml(u.name)}</strong></td>
                  <td>${this.escapeHtml(u.email)}</td>
                  <td>${this.escapeHtml(u.phone || '—')}</td>
                  <td><span class="badge exam">${u.count} ტესტი</span></td>
                  <td>${this.escapeHtml(u.lastDate || '—')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // ივენთები
    document.getElementById('btnAdminBackHome').onclick = () => {
      this.renderHome();
    };

    document.getElementById('btnRefreshCloud').onclick = async () => {
      const btn = document.getElementById('btnRefreshCloud');
      if (btn) btn.innerText = '⏳ მიმდინარეობს განახლება...';
      await this.syncFromCloud();
      this.renderAdminPanel(true);
    };

    document.getElementById('btnSaveNewPin').onclick = async () => {
      const newPin = document.getElementById('newPinInput').value.trim();
      if (!newPin || newPin.length < 3) {
        alert("პაროლი უნდა შეიცავდეს მინიმუმ 3 სიმბოლოს!");
        return;
      }
      this.setAdminPin(newPin);
      await this.pushToCloud(null, false, newPin);
      alert("ადმინისტრატორის ახალი საიდუმლო პაროლი წარმატებით შეინახა ღრუბლოვან ბაზაში! ძველი კოდი გაუქმებულია.");
      this.renderAdminPanel(true);
    };

    document.getElementById('btnExportExcel').onclick = () => {
      this.exportResultsToCSV();
    };

    document.getElementById('btnClearJournal').onclick = async () => {
      if (confirm("ნამდვილად გსურთ შედეგების ჟურნალის გასუფთავება? წაიშლება როგორც ლოკალური, ისე ონლაინ ჩანაწერები.")) {
        localStorage.removeItem('exam_results_journal');
        await this.pushToCloud(null, true);
        this.renderAdminPanel(true);
      }
    };

    app.querySelectorAll('.view-details-btn').forEach(btn => {
      btn.onclick = (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        this.showSubmissionDetails(journal[idx]);
      };
    });
  }

  showSubmissionDetails(row) {
    if (!row) return;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'genericModalOverlay';
    overlay.innerHTML = `
      <div class="modal-card wide">
        <div class="modal-header">
          <h3>📋 საგამოცდო უწყისი: ${this.escapeHtml(row.candidateName)}</h3>
          <button class="modal-close-btn" id="modalCloseBtn">&times;</button>
        </div>
        <div class="modal-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px;background:#f8fafc;padding:14px;border-radius:8px;">
            <div><strong>თარიღი:</strong> ${row.date}</div>
            <div><strong>Gmail:</strong> ${this.escapeHtml(row.candidateEmail)}</div>
            <div><strong>პროფილი:</strong> ${this.escapeHtml(row.profileTitle)}</div>
            <div><strong>საერთო ქულა:</strong> ${row.score} / ${row.total} (${row.percent}%)</div>
            <div><strong>სტატუსი:</strong> <span class="tag-status ${row.passed ? 'pass' : 'fail'}">${row.passed ? 'ჩაბარებულია' : 'ჩაჭრილია'}</span></div>
            <div><strong>დრო:</strong> ${row.timeSpentMinutes} წუთი</div>
          </div>

          <h4 style="font-size:15px;color:#1e293b;margin-bottom:10px;">ქვეთავობრივი ჩაშლა (დადგენილება №134):</h4>
          <div style="max-height:340px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;">
            <table class="subchapters-mini-table">
              <thead>
                <tr>
                  <th>ქვეთავი</th>
                  <th>თემატიკა</th>
                  <th>სწორი</th>
                  <th>სულ</th>
                  <th>%</th>
                  <th>შედეგი</th>
                </tr>
              </thead>
              <tbody>
                ${(row.subStats || []).map(st => `
                  <tr style="background:${st.passed ? '#f0fdf4' : '#fef2f2'}">
                    <td><strong>${this.escapeHtml(st.name)}</strong></td>
                    <td>${this.escapeHtml(st.chapterName || '-')}</td>
                    <td><strong>${st.correct}</strong></td>
                    <td>${st.total}</td>
                    <td><strong>${st.percent}%</strong></td>
                    <td><span class="tag-status ${st.passed ? 'pass' : 'fail'}">${st.passed ? 'გადალახულია' : 'ჩაჭრილია'}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="modalCloseFootBtn">დახურვა</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('modalCloseBtn').onclick = close;
    document.getElementById('modalCloseFootBtn').onclick = close;
  }

  exportResultsToCSV() {
    const journal = JSON.parse(localStorage.getItem('exam_results_journal') || '[]');
    if (journal.length === 0) {
      alert("შედეგების ჟურნალი ცარიელია! ექსპორტისთვის ჩანაწერები არ მოიძებნა.");
      return;
    }

    // UTF-8 with BOM ქართული Excel-ის მხარდაჭერისთვის
    let csv = '\uFEFF';
    csv += 'ID;თარიღი და დრო;კანდიდატის სახელი;Gmail მისამართი;საგამოცდო პროფილი;სირთულე;რეჟიმი;ქულა;სულ;პროცენტი;სტატუსი;დახარჯული დრო (წთ)\r\n';

    journal.forEach(row => {
      const statusTxt = row.passed ? 'ჩაბარებულია' : 'ჩაჭრილია';
      const diffTxt = row.difficultyTitle || (row.difficulty === 'hard' ? 'რთული' : (row.difficulty === 'medium' ? 'საშუალო' : 'მარტივი'));
      csv += `"${row.id}";"${row.date}";"${row.candidateName}";"${row.candidateEmail}";"${row.profileTitle}";"${diffTxt}";"${row.mode}";"${row.score}";"${row.total}";"${row.percent}%";"${statusTxt}";"${row.timeSpentMinutes}"\r\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sagamocto_shedegebi_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

window.ExamUI = ExamUI;