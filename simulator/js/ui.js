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

// =====================================================================
// ავტორიზაციის კონფიგურაცია (ელ-ფოსტა + პაროლი)
//
// სანამ FIREBASE_CONFIG = null, ანგარიშები ინახება მხოლოდ ამ ბრაუზერში
// (პაროლი არ ინახება — მხოლოდ PBKDF2-SHA256 ჰეში მარილით).
//
// ნებისმიერი მოწყობილობიდან შესასვლელად ჩასვით Firebase პროექტის კონფიგი:
//   const FIREBASE_CONFIG = {
//     apiKey: "AIza...",
//     authDomain: "your-project.firebaseapp.com",
//     projectId: "your-project"
//   };
// (Firebase Console → Authentication → Sign-in method → Email/Password: Enable;
//  Authentication → Settings → Authorized domains: დაამატეთ kobaliaint-design.github.io)
// =====================================================================
const FIREBASE_CONFIG = null;
const FIREBASE_SDK_VERSION = '10.12.2';
const AUTH_MIN_PASSWORD = 6;

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
    // გაჟონილი ძველი ექაუნთების გაწმენდა ლოკალური მეხსიერებიდან
    try {
      localStorage.removeItem('exam_registered_users');
    } catch(e) {}
    this.candidate = this.loadCandidate();
    // ძველი (პაროლის გარეშე) სესიების გაუქმება — შესვლა მხოლოდ ელ-ფოსტით და პაროლით
    if (this.candidate && this.candidate.authVersion !== 2) {
      this.clearCandidateSession();
    }
    this.initAuth();
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
                this.getCookie('exam_current_user');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.name) {
        return parsed;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  saveCandidate(name, emailOrId, phone = '', picture = '') {
    this.candidate = {
      name: (name || '').trim(),
      email: (emailOrId || '').trim().toLowerCase(),
      phone: (phone || '').trim(),
      picture: picture || '',
      signedIn: true,
      authVersion: 2,
      lastLogin: Date.now()
    };
    const candJson = JSON.stringify(this.candidate);
    try {
      localStorage.setItem('exam_current_user', candJson);
      sessionStorage.setItem('exam_candidate', candJson);
      localStorage.setItem('exam_last_candidate', candJson);
    } catch(e) {}
    this.setCookie('exam_current_user', candJson, 365);
  }

  clearCandidateSession() {
    this.candidate = null;
    try {
      localStorage.removeItem('exam_current_user');
      sessionStorage.removeItem('exam_candidate');
      localStorage.removeItem('exam_last_candidate');
    } catch(e) {}
    this.setCookie('exam_current_user', '', -1);
  }

  async signOutCandidate() {
    this.clearCandidateSession();
    if (this.isFirebaseMode()) {
      try {
        const auth = await this.getFirebaseAuth();
        await auth.signOut();
      } catch (e) {}
    }
    this.renderHome();
  }

  // ===================== ავტორიზაცია: ელ-ფოსტა + პაროლი =====================

  isFirebaseMode() {
    return Boolean(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);
  }

  nameFromEmail(email) {
    return String(email || '').split('@')[0] || 'კანდიდატი';
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('ვერ ჩაიტვირთა: ' + src));
      document.head.appendChild(s);
    });
  }

  getFirebaseAuth() {
    if (!this.isFirebaseMode()) return Promise.resolve(null);
    if (!this._fbAuthPromise) {
      this._fbAuthPromise = (async () => {
        const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
        if (typeof firebase === 'undefined') await this.loadScript(`${base}/firebase-app-compat.js`);
        if (!firebase.auth) await this.loadScript(`${base}/firebase-auth-compat.js`);
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        const auth = firebase.auth();
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        return auth;
      })();
      this._fbAuthPromise.catch(() => { this._fbAuthPromise = null; });
    }
    return this._fbAuthPromise;
  }

  async initAuth() {
    if (!this.isFirebaseMode()) return;
    try {
      const auth = await this.getFirebaseAuth();
      auth.onAuthStateChanged((user) => {
        const onHome = Boolean(document.querySelector('.home-container'));
        if (user && user.email) {
          if (!this.candidate || this.candidate.email !== user.email.toLowerCase()) {
            this.saveCandidate(this.nameFromEmail(user.email), user.email);
            if (onHome) this.renderHome();
          }
        } else if (this.candidate) {
          this.clearCandidateSession();
          if (onHome) this.renderHome();
        }
      });
    } catch (e) {
      console.warn('Firebase init notice:', e);
    }
  }

  // --- ლოკალური ანგარიშები (PBKDF2 ჰეში, პაროლი არსად ინახება) ---

  getLocalAccounts() {
    try {
      return JSON.parse(localStorage.getItem('exam_accounts_v2') || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  saveLocalAccounts(accounts) {
    localStorage.setItem('exam_accounts_v2', JSON.stringify(accounts || {}));
  }

  bufToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  async hashPassword(password, saltHex, iterations) {
    if (!window.crypto || !crypto.subtle) throw { code: 'no-crypto' };
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: this.hexToBytes(saltHex), iterations },
      key,
      256
    );
    return this.bufToHex(bits);
  }

  safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }

  // აბრუნებს 'ok' (შევიდა) ან 'not-found' (ანგარიში არ არსებობს); არასწორ პაროლზე აგდებს შეცდომას
  async authTryLogin(email, password) {
    if (this.isFirebaseMode()) {
      const auth = await this.getFirebaseAuth();
      try {
        await auth.signInWithEmailAndPassword(email, password);
        return 'ok';
      } catch (e) {
        if (e.code === 'auth/wrong-password') throw { code: 'wrong-password' };
        if (['auth/user-not-found', 'auth/invalid-credential', 'auth/invalid-login-credentials'].includes(e.code)) {
          return 'not-found';
        }
        throw e;
      }
    }

    const acc = this.getLocalAccounts()[email];
    if (!acc) return 'not-found';
    const hash = await this.hashPassword(password, acc.salt, acc.iter);
    if (!this.safeEqual(hash, acc.hash)) throw { code: 'wrong-password' };
    return 'ok';
  }

  async authRegister(email, password) {
    if (this.isFirebaseMode()) {
      const auth = await this.getFirebaseAuth();
      try {
        await auth.createUserWithEmailAndPassword(email, password);
        return;
      } catch (e) {
        if (e.code === 'auth/email-already-in-use') throw { code: 'exists' };
        throw e;
      }
    }

    const accounts = this.getLocalAccounts();
    if (accounts[email]) throw { code: 'exists' };
    const salt = this.bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    const iter = 150000;
    accounts[email] = { salt, iter, hash: await this.hashPassword(password, salt, iter), createdAt: Date.now() };
    this.saveLocalAccounts(accounts);
  }

  authErrorText(e) {
    const code = (e && e.code) || '';
    const map = {
      'wrong-password': 'პაროლი არასწორია.',
      'exists': 'ამ ელ-ფოსტით ანგარიში უკვე არსებობს — შეამოწმეთ პაროლი.',
      'no-crypto': 'ბრაუზერი არ უჭერს მხარს უსაფრთხო შიფრაციას. გამოიყენეთ Chrome / Edge / Firefox.',
      'locked': 'ძალიან ბევრი წარუმატებელი მცდელობა. სცადეთ 1 წუთში.',
      'auth/too-many-requests': 'ძალიან ბევრი მცდელობა. სცადეთ რამდენიმე წუთში.',
      'auth/network-request-failed': 'ინტერნეტთან კავშირი ვერ დამყარდა.',
      'auth/invalid-email': 'ელ-ფოსტის ფორმატი არასწორია.',
      'auth/weak-password': `პაროლი უნდა შედგებოდეს მინიმუმ ${AUTH_MIN_PASSWORD} სიმბოლოსგან.`,
      'auth/operation-not-allowed': 'Firebase-ში ჩართული არ არის Email/Password შესვლა.'
    };
    return map[code] || 'შესვლა ვერ მოხერხდა. სცადეთ თავიდან.';
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
      alert("საგამოცდო დრო (180 წთ) ამოიწურა! თქვენი ნაშრომი გადაგზავნილია შესაფასებლად.");
      this.renderResults();
    };
  }

  promptCandidateModal(onSuccess) {
    const existing = document.getElementById('genericModalOverlay');
    if (existing) existing.remove();

    this.pendingAfterAuth = onSuccess || null;
    const fbMode = this.isFirebaseMode();

    const overlay = document.createElement('div');
    overlay.id = 'genericModalOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:420px;">
        <div class="modal-header" style="border-bottom:1px solid #e2e8f0;padding-bottom:12px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:24px;">🔐</span>
            <h3 id="authTitle" style="margin:0;font-size:18px;color:#0f172a;font-weight:700;">შესვლა</h3>
          </div>
          <button class="modal-close-btn" id="modalCloseBtn">&times;</button>
        </div>

        <div class="modal-body" style="padding:20px 22px;">
          <form id="authForm" autocomplete="on" novalidate>
            <div class="form-group" style="margin-bottom:14px;text-align:left;">
              <label class="form-label" for="authEmail" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">ელ-ფოსტა</label>
              <input type="email" id="authEmail" name="email" class="form-input" autocomplete="username"
                     placeholder="name@gmail.com"
                     style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;" required autofocus>
            </div>

            <div class="form-group" style="margin-bottom:14px;text-align:left;">
              <label class="form-label" for="authPassword" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">პაროლი</label>
              <input type="password" id="authPassword" name="password" class="form-input" autocomplete="current-password"
                     placeholder="მინიმუმ ${AUTH_MIN_PASSWORD} სიმბოლო"
                     style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;" required>
            </div>

            <div id="authConfirmWrap" style="display:none;margin-bottom:14px;text-align:left;">
              <div id="authNewInfo" style="font-size:13px;color:#1e40af;background:#eff6ff;border:1px solid #bfdbfe;padding:9px 12px;border-radius:6px;margin-bottom:10px;line-height:1.45;"></div>
              <label class="form-label" for="authPassword2" style="font-size:13px;font-weight:700;color:#1e293b;display:block;margin-bottom:6px;">გაიმეორეთ პაროლი</label>
              <input type="password" id="authPassword2" class="form-input" autocomplete="new-password"
                     style="width:100%;font-size:14px;padding:10px 12px;box-sizing:border-box;">
            </div>

            <div id="authError" style="color:#dc2626;font-size:13px;display:none;margin-bottom:14px;font-weight:600;background:#fef2f2;padding:9px 12px;border-radius:6px;border:1px solid #fecaca;"></div>
            <div id="authInfo" style="color:#065f46;font-size:13px;display:none;margin-bottom:14px;font-weight:600;background:#ecfdf5;padding:9px 12px;border-radius:6px;border:1px solid #6ee7b7;"></div>

            <button type="submit" id="authSubmit" class="btn btn-primary" style="width:100%;padding:12px;font-size:15px;font-weight:700;border-radius:8px;cursor:pointer;">
              შესვლა
            </button>

            <p style="font-size:12px;color:#64748b;margin:12px 0 0;text-align:center;line-height:1.45;">
              პირველად შემოდიხართ? შეიყვანეთ ელ-ფოსტა და მოიფიქრეთ პაროლი — ანგარიში შეიქმნება.
            </p>
            ${fbMode ? `
              <div style="text-align:center;margin-top:8px;">
                <button type="button" id="authForgot" style="background:none;border:none;color:#2563eb;font-size:12.5px;cursor:pointer;text-decoration:underline;">დაგავიწყდათ პაროლი?</button>
              </div>
            ` : ''}
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    document.getElementById('modalCloseBtn').onclick = close;

    const $ = (id) => document.getElementById(id);
    const emailEl = $('authEmail');
    const passEl = $('authPassword');
    const pass2El = $('authPassword2');
    const confirmWrap = $('authConfirmWrap');
    const submitBtn = $('authSubmit');
    const errBox = $('authError');
    const infoBox = $('authInfo');

    let registerMode = false;
    let registerEmail = '';

    const showError = (msg) => {
      infoBox.style.display = 'none';
      errBox.innerText = msg;
      errBox.style.display = msg ? 'block' : 'none';
    };

    const setRegisterMode = (on, email) => {
      registerMode = on;
      registerEmail = on ? email : '';
      confirmWrap.style.display = on ? 'block' : 'none';
      $('authTitle').innerText = on ? 'ახალი ანგარიში' : 'შესვლა';
      submitBtn.innerText = on ? 'რეგისტრაცია და შესვლა' : 'შესვლა';
      passEl.autocomplete = on ? 'new-password' : 'current-password';
      if (on) {
        $('authNewInfo').innerHTML = fbMode
          ? `ელ-ფოსტით <strong>${this.escapeHtml(email)}</strong> შესვლა ვერ მოხერხდა.<br>თუ ახალი ხართ — გაიმეორეთ პაროლი და დარეგისტრირდით. თუ ანგარიში უკვე გაქვთ — პაროლი არასწორია.`
          : `ელ-ფოსტით <strong>${this.escapeHtml(email)}</strong> ანგარიში ჯერ არ არსებობს.<br>გაიმეორეთ პაროლი რეგისტრაციისთვის.`;
        pass2El.value = '';
        pass2El.focus();
      }
    };

    // ელ-ფოსტის შეცვლისას რეგისტრაციის რეჟიმი უქმდება
    emailEl.addEventListener('input', () => {
      if (registerMode) setRegisterMode(false);
      showError('');
    });

    const finish = () => {
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

    // უხეში ძალის (brute force) შეზღუდვა: 5 წარუმატებელი ცდის შემდეგ 1 წუთით ბლოკი
    const isLocked = () => (this._authLockUntil || 0) > Date.now();
    const registerFailure = () => {
      this._authFails = (this._authFails || 0) + 1;
      if (this._authFails >= 5) {
        this._authFails = 0;
        this._authLockUntil = Date.now() + 60 * 1000;
      }
    };

    $('authForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = (emailEl.value || '').trim().toLowerCase();
      const password = passEl.value || '';

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        showError('შეიყვანეთ სწორი ელ-ფოსტა.');
        emailEl.focus();
        return;
      }
      if (password.length < AUTH_MIN_PASSWORD) {
        showError(`პაროლი უნდა შედგებოდეს მინიმუმ ${AUTH_MIN_PASSWORD} სიმბოლოსგან.`);
        passEl.focus();
        return;
      }
      if (isLocked()) {
        showError(this.authErrorText({ code: 'locked' }));
        return;
      }

      submitBtn.disabled = true;
      const oldLabel = submitBtn.innerText;
      submitBtn.innerText = 'მოწმდება...';
      showError('');

      try {
        if (registerMode && registerEmail === email) {
          if (pass2El.value !== password) {
            showError('პაროლები არ ემთხვევა.');
            pass2El.focus();
            return;
          }
          await this.authRegister(email, password);
          this._authFails = 0;
          this.saveCandidate(this.nameFromEmail(email), email);
          finish();
          return;
        }

        const result = await this.authTryLogin(email, password);
        if (result === 'ok') {
          this._authFails = 0;
          this.saveCandidate(this.nameFromEmail(email), email);
          finish();
          return;
        }
        if (fbMode) registerFailure();
        setRegisterMode(true, email);
      } catch (err) {
        if (err && (err.code === 'wrong-password' || err.code === 'exists')) registerFailure();
        showError(this.authErrorText(err));
        if (err && err.code === 'wrong-password') {
          passEl.value = '';
          passEl.focus();
        }
      } finally {
        submitBtn.disabled = false;
        if (submitBtn.innerText === 'მოწმდება...') submitBtn.innerText = oldLabel;
      }
    };

    const forgotBtn = $('authForgot');
    if (forgotBtn) {
      forgotBtn.onclick = async () => {
        const email = (emailEl.value || '').trim().toLowerCase();
        if (!email) {
          showError('ჯერ შეიყვანეთ ელ-ფოსტა.');
          emailEl.focus();
          return;
        }
        try {
          const auth = await this.getFirebaseAuth();
          await auth.sendPasswordResetEmail(email);
        } catch (err) {
          // ანგარიშის არსებობას არ ვამხელთ
        }
        errBox.style.display = 'none';
        infoBox.innerText = 'თუ ეს ელ-ფოსტა რეგისტრირებულია, პაროლის აღდგენის ბმული გამოგეგზავნებათ.';
        infoBox.style.display = 'block';
      };
    }
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
    const isSigned = Boolean(this.candidate && this.candidate.name);
    const showSignedBanner = Boolean(this.justSignedIn);
    this.justSignedIn = false;

    app.innerHTML = `
      <div class="home-container">
        <!-- ზედა მართვის ზოლი -->
        <div class="top-nav-bar">
          <div class="candidate-bar" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span class="cand-name" id="homeCandDisplay" style="display:inline-flex;align-items:center;gap:8px;background:${isSigned ? '#ecfdf5' : '#f8fafc'};border:1px solid ${isSigned ? '#6ee7b7' : '#cbd5e1'};padding:6px 12px;border-radius:8px;font-weight:600;font-size:13.5px;color:${isSigned ? '#065f46' : '#475569'};">
              ${isSigned && this.candidate.picture ? `<img src="${this.escapeHtml(this.candidate.picture)}" alt="" style="width:22px;height:22px;border-radius:50%;">` : ''}
              ${isSigned ? `🟢 <strong>${this.escapeHtml(this.candidate.email || this.candidate.name)}</strong>` : '⚪ არ ხართ შესული'}
            </span>
            ${!isSigned ? `<button class="btn btn-subtle" id="btnChangeCand" style="display:inline-flex;align-items:center;gap:8px;background:#fff;border:1.5px solid #2563eb;padding:6px 14px;border-radius:8px;font-weight:700;color:#1e293b;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
              <span>🔐</span>
              <span>შესვლა / რეგისტრაცია</span>
            </button>` : ''}
            ${isSigned ? `<button class="btn btn-subtle" id="btnSignOutCand" style="padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600;color:#dc2626;border:1px solid #fecaca;background:#fef2f2;cursor:pointer;">🚪 გასვლა</button>` : ''}
          </div>
          <div class="admin-bar">
            <button class="btn btn-admin" id="btnAdminLogin">🔐 ადმინ პანელი</button>
          </div>
        </div>

        ${showSignedBanner ? `
          <div style="background:#ecfdf5;border:1.5px solid #10b981;color:#065f46;padding:12px 18px;border-radius:10px;margin-bottom:16px;font-weight:600;font-size:14px;display:flex;align-items:center;gap:10px;">
            <span>✅</span>
            <span>ავტორიზაცია წარმატებულია: <strong>${this.escapeHtml(this.candidate.name)}</strong> (${this.escapeHtml(this.candidate.email)})</span>
          </div>
        ` : ''}

        <header class="home-header">
          <div class="gov-badge">საქართველოს ეკონომიკისა და მდგრადი განვითარების სამინისტრო • ISO/IEC 17024</div>
          <h1>არქიტექტორებისა და ინჟინერ-მშენებლების სერტიფიცირების საგამოცდო სისტემა</h1>
          <p class="subtitle">საქართველოს მთავრობის №134 დადგენილების, №41, №732, №255, №261 დადგენილებებისა და სამშენებლო კოდექსის (№3213-რს) ოფიციალური საგამოცდო სიმულატორი</p>
          <div class="mandatory-date-badge">
            <span class="pulse-dot"></span>
            სავალდებულო სერტიფიცირების ამოქმედების თარიღი: <strong>2026 წლის 20 დეკემბერი</strong>
          </div>
        </header>

        <section class="profile-selection-section">
          <h2>აირჩიეთ საგამოცდო პროფილი და რეჟიმი:</h2>
          <div class="profile-cards-grid">
            ${Object.values(profiles).map(p => `
              <div class="profile-card" data-id="${p.id}">
                <div class="card-field-tag ${p.field}">${p.field === 'architecture' ? 'არქიტექტურა' : 'კონსტრუქცია'}</div>
                <h3 class="profile-name">${p.title}</h3>
                <div class="profile-criteria">
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
                    <span class="crit-val">100 კითხვა • 180 წუთი (3 საათი) • CBT</span>
                  </div>
                </div>
                <div class="card-actions">
                  <button class="btn btn-primary start-exam-btn" data-id="${p.id}" data-mode="exam">
                    საგამოცდო რეჟიმი (180 წთ, 100 კითხვა)
                  </button>
                  <button class="btn btn-secondary start-study-btn" data-id="${p.id}" data-mode="study">
                    სასწავლო რეჟიმი (განმარტებებით)
                  </button>
                </div>
              </div>
            `).join('')}
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

    app.querySelectorAll('.start-exam-btn, .start-study-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const profileId = e.currentTarget.getAttribute('data-id');
        const mode = e.currentTarget.getAttribute('data-mode');
        this.startTestWithCheck(profileId, mode);
      });
    });
  }

  startTestWithCheck(profileId, mode) {
    if (!this.candidate || !this.candidate.name) {
      this.promptCandidateModal(() => this.startTest(profileId, mode));
      return;
    }
    this.startTest(profileId, mode);
  }

  startTest(profileId, mode) {
    this.engine.startExam(profileId, mode);
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
            <span class="badge candidate-badge" style="background:#ecfdf5;color:#065f46;border:1.5px solid #10b981;font-weight:700;">🟢 ავტორიზებულია: ${this.candidate ? this.escapeHtml(this.candidate.name) : ''}</span>
            <span class="passing-rule-hint">ბარიერი: ≥ ${(exam.profile.passing_score_subchapter * 100).toFixed(0)}% ქვეთავში</span>
          </div>

          <div class="header-center">
            <div class="timer-box" id="timerBox">
              <span class="timer-icon">⏱️</span>
              <span id="timerDigits" class="timer-digits">03:00:00</span>
            </div>
          </div>

          <div class="header-right">
            <button id="calcToggleBtn" class="btn btn-icon" title="საინჟინრო კალკულატორი">
              ⚙️ კალკულატორი
            </button>
            <button id="finishExamBtn" class="btn btn-danger">
              გამოცდის დასრულება
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
    const calcBtn = document.getElementById('calcToggleBtn');
    if (calcBtn) {
      calcBtn.addEventListener('click', () => this.calculator.toggle());
    }

    // დასრულება
    document.getElementById('finishExamBtn').addEventListener('click', () => {
      this.promptFinishExam();
    });

    // ნავიგაცია
    document.getElementById('prevBtn').addEventListener('click', () => {
      if (exam.currentIndex > 0) {
        exam.currentIndex--;
        this.renderCurrentQuestion();
        this.updatePalette();
      }
    });

    document.getElementById('nextBtn').addEventListener('click', () => {
      if (exam.currentIndex < exam.questions.length - 1) {
        exam.currentIndex++;
        this.renderCurrentQuestion();
        this.updatePalette();
      }
    });

    // დროშა
    document.getElementById('flagBtn').addEventListener('click', () => {
      this.engine.toggleFlag(exam.currentIndex);
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
        <span class="q-number-pill">კითხვა №${exam.currentIndex + 1}</span>
        <span class="q-required-pill ${reqChoices > 1 ? 'multi' : 'single'}">
          ${reqChoices > 1 ? `⚠️ აირჩიეთ ${reqChoices} სწორი პასუხი` : `აირჩიეთ 1 სწორი პასუხი`}
        </span>
        <span class="q-ref-pill">${q.reference || ''}</span>
      </div>

      <div class="q-text">${q.question}</div>

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
              <div class="opt-content">${opt}</div>
            </div>
          `;
        }).join('')}
      </div>

      ${(exam.mode === 'study' && isAnswered) ? `
        <div class="study-explanation-box">
          <div class="study-title">💡 ნორმატიული განმარტება და სამართლებრივი საფუძველი:</div>
          <div class="study-text">${q.explanation || 'განმარტება მოცემულია შესაბამის სტანდარტში.'}</div>
          <div class="study-ref"><strong>მითითება:</strong> ${q.reference || 'საქართველოს მოქმედი სამშენებლო ნორმები'}</div>
        </div>
      ` : ''}
    `;

    // ვარიანტის არჩევა
    card.querySelectorAll('.q-option').forEach(el => {
      el.addEventListener('click', () => {
        const optIdx = parseInt(el.getAttribute('data-opt'), 10);
        this.engine.selectAnswer(exam.currentIndex, optIdx);
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

    let msg = "ნამდვილად გსურთ გამოცდის დასრულება და ნაშრომის გადაგზავნა?";
    if (unanswered > 0) {
      msg = `ყურადღება! თქვენ გაქვთ ${unanswered} გაუცემელი პასუხი 100-დან.\n\n` + msg;
    }

    if (confirm(msg)) {
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
      let cloudPin = forceNewPin ? String(forceNewPin) : this.getAdminPin();
      let cloudGoogleClientId = forceGoogleClientId ? String(forceGoogleClientId) : this.getGoogleClientId();

      if (!clearAll) {
        try {
          const getResp = await fetch(this.getCloudApiUrl(), { cache: 'no-store' });
          if (getResp.ok) {
            const obj = await getResp.json();
            if (obj && obj.data) {
              if (Array.isArray(obj.data.entries)) currentCloud = obj.data.entries;
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
          <div class="rev-text">${q.question}</div>
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
                  <span>${String.fromCharCode(65 + optIdx)}. ${opt}</span>
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
                  <td colspan="10" style="text-align:center;padding:40px;color:#64748b;">
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
    csv += 'ID;თარიღი და დრო;კანდიდატის სახელი;Gmail მისამართი;საგამოცდო პროფილი;რეჟიმი;ქულა;სულ;პროცენტი;სტატუსი;დახარჯული დრო (წთ)\r\n';

    journal.forEach(row => {
      const statusTxt = row.passed ? 'ჩაბარებულია' : 'ჩაჭრილია';
      csv += `"${row.id}";"${row.date}";"${row.candidateName}";"${row.candidateEmail}";"${row.profileTitle}";"${row.mode}";"${row.score}";"${row.total}";"${row.percent}%";"${statusTxt}";"${row.timeSpentMinutes}"\r\n`;
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