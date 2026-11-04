/**
 * საინჟინრო კალკულატორი და SI ერთეულების პროფესიული გადამყვანი
 * მხარს უჭერს გრადუსებს (DEG) და რადიანებს (RAD), ტრიგონომეტრიას, ხარისხებსა და SI კონვერტაციას.
 */

class EngineeringCalculator {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.currentExpr = '0';
    this.isDegreeMode = true; // Default to Degrees for civil engineering
    this.init();
  }

  init() {
    if (!this.container) return;
    this.render();
    this.bindEvents();
  }

  render() {
    this.container.innerHTML = `
      <div class="calc-modal-content">
        <div class="calc-header">
          <div class="calc-title">
            <span class="calc-icon">⚙️</span>
            <span>საინჟინრო კალკულატორი & SI კონვერტორი</span>
          </div>
          <button class="calc-close-btn" id="calcCloseBtn" title="დახურვა">&times;</button>
        </div>
        <div class="calc-display-wrap">
          <div class="calc-mode-indicator" id="calcModeIndicator">DEG (გრადუსი)</div>
          <input type="text" id="calcDisplay" class="calc-display" value="0" readonly />
        </div>
        <div class="calc-tabs">
          <button class="calc-tab active" data-tab="calc-keypad">კალკულატორი</button>
          <button class="calc-tab" data-tab="calc-converter">SI კონვერტორი</button>
        </div>
        
        <div id="calc-keypad" class="calc-tab-content active">
          <div class="calc-grid">
            <button class="calc-btn fn" id="btnDegRad" data-act="deg-rad">DEG</button>
            <button class="calc-btn fn" data-act="sin">sin</button>
            <button class="calc-btn fn" data-act="cos">cos</button>
            <button class="calc-btn fn" data-act="tan">tan</button>
            <button class="calc-btn fn" data-act="pi">π</button>

            <button class="calc-btn fn" data-act="sqrt">√</button>
            <button class="calc-btn fn" data-act="sqr">x²</button>
            <button class="calc-btn fn" data-act="pow">xʸ</button>
            <button class="calc-btn fn" data-act="ln">ln</button>
            <button class="calc-btn op" data-act="clear">C</button>

            <button class="calc-btn fn" data-act="bracket-open">(</button>
            <button class="calc-btn fn" data-act="bracket-close">)</button>
            <button class="calc-btn fn" data-act="back">&larr;</button>
            <button class="calc-btn op" data-act="/">÷</button>
            <button class="calc-btn op" data-act="*">×</button>

            <button class="calc-btn num" data-val="7">7</button>
            <button class="calc-btn num" data-val="8">8</button>
            <button class="calc-btn num" data-val="9">9</button>
            <button class="calc-btn op" data-act="-">−</button>
            <button class="calc-btn fn" data-act="1/x">1/x</button>

            <button class="calc-btn num" data-val="4">4</button>
            <button class="calc-btn num" data-val="5">5</button>
            <button class="calc-btn num" data-val="6">6</button>
            <button class="calc-btn op" data-act="+">+</button>
            <button class="calc-btn fn" data-act="percent">%</button>

            <button class="calc-btn num" data-val="1">1</button>
            <button class="calc-btn num" data-val="2">2</button>
            <button class="calc-btn num" data-val="3">3</button>
            <button class="calc-btn equals" data-act="eval">=</button>
            <button class="calc-btn num" data-val="0">0</button>

            <button class="calc-btn num" data-val=".">.</button>
            <button class="calc-btn num" data-val="00">00</button>
          </div>
        </div>

        <div id="calc-converter" class="calc-tab-content">
          <div class="converter-box">
            <div class="conv-row">
              <label>კატეგორია:</label>
              <select id="convCategory" class="calc-select">
                <option value="stress">ძაბვა / წნევა (მპა, კპა, კგძ/სმ²)</option>
                <option value="force">ძალა / დატვირთვა (კნ, ნ, კგძ, ტძ)</option>
                <option value="moment">მომენტი (კნ·მ, კგძ·მ, ნ·მმ)</option>
                <option value="length">სიგრძე (მ, სმ, მმ)</option>
              </select>
            </div>
            <div class="conv-grid">
              <div class="conv-col">
                <label>მნიშვნელობა:</label>
                <input type="number" id="convInput" class="conv-input" value="1" step="any" />
                <select id="convFromUnit" class="calc-select"></select>
              </div>
              <div class="conv-arrow">➔</div>
              <div class="conv-col">
                <label>შედეგი:</label>
                <input type="text" id="convOutput" class="conv-input" readonly />
                <select id="convToUnit" class="calc-select"></select>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    const display = document.getElementById('calcDisplay');
    const closeBtn = document.getElementById('calcCloseBtn');
    
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.toggle(false);
      });
    }

    // ტაბების გადართვა
    const tabs = this.container.querySelectorAll('.calc-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        tabs.forEach(t => t.classList.remove('active'));
        this.container.querySelectorAll('.calc-tab-content').forEach(c => c.classList.remove('active'));
        e.target.classList.add('active');
        const targetId = e.target.getAttribute('data-tab');
        const targetEl = document.getElementById(targetId);
        if (targetEl) targetEl.classList.add('active');
      });
    });

    // კალკულატორის ღილაკები
    this.container.querySelectorAll('.calc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-val');
        const act = btn.getAttribute('data-act');

        if (val !== null) {
          if ((this.currentExpr === '0' || this.currentExpr === 'შეცდომა') && val !== '.') {
            this.currentExpr = val;
          } else {
            this.currentExpr += val;
          }
        } else if (act) {
          this.handleAction(act);
        }
        if (display) display.value = this.currentExpr;
      });
    });

    // კონვერტორის ინიციალიზაცია
    this.initConverter();
  }

  handleAction(act) {
    try {
      if (act === 'clear') {
        this.currentExpr = '0';
      } else if (act === 'deg-rad') {
        this.isDegreeMode = !this.isDegreeMode;
        const btn = document.getElementById('btnDegRad');
        const ind = document.getElementById('calcModeIndicator');
        if (btn) btn.innerText = this.isDegreeMode ? 'DEG' : 'RAD';
        if (ind) ind.innerText = this.isDegreeMode ? 'DEG (გრადუსი)' : 'RAD (რადიანი)';
      } else if (act === 'back') {
        if (this.currentExpr === 'შეცდომა') {
          this.currentExpr = '0';
        } else {
          this.currentExpr = this.currentExpr.slice(0, -1);
          if (!this.currentExpr) this.currentExpr = '0';
        }
      } else if (act === 'eval') {
        let safeExpr = this.currentExpr
          .replace(/×/g, '*')
          .replace(/÷/g, '/')
          .replace(/−/g, '-')
          .replace(/\^/g, '**');
        const res = Function('"use strict";return (' + safeExpr + ')')();
        this.currentExpr = String(Number(Number(res).toFixed(6)));
      } else if (act === 'sin' || act === 'cos' || act === 'tan') {
        let num = parseFloat(this.currentExpr) || 0;
        let rad = this.isDegreeMode ? (num * Math.PI / 180) : num;
        let res = 0;
        if (act === 'sin') res = Math.sin(rad);
        if (act === 'cos') res = Math.cos(rad);
        if (act === 'tan') res = Math.tan(rad);
        this.currentExpr = String(Number(res.toFixed(6)));
      } else if (act === 'sqrt') {
        let num = parseFloat(this.currentExpr) || 0;
        this.currentExpr = String(Number(Math.sqrt(num).toFixed(6)));
      } else if (act === 'sqr') {
        let num = parseFloat(this.currentExpr) || 0;
        this.currentExpr = String(Number(Math.pow(num, 2).toFixed(6)));
      } else if (act === 'pow') {
        this.currentExpr += '^';
      } else if (act === 'pi') {
        if (this.currentExpr === '0' || this.currentExpr === 'შეცდომა') {
          this.currentExpr = String(Math.PI.toFixed(6));
        } else {
          this.currentExpr += '*' + Math.PI.toFixed(6);
        }
      } else if (act === 'ln') {
        let num = parseFloat(this.currentExpr) || 0;
        this.currentExpr = String(Number(Math.log(num).toFixed(6)));
      } else if (act === '1/x') {
        let num = parseFloat(this.currentExpr) || 0;
        this.currentExpr = String(Number((1 / num).toFixed(6)));
      } else if (act === '+' || act === '-' || act === '*' || act === '/') {
        if (this.currentExpr === 'შეცდომა') this.currentExpr = '0';
        this.currentExpr += act;
      } else if (act === 'bracket-open') {
        if (this.currentExpr === '0' || this.currentExpr === 'შეცდომა') this.currentExpr = '(';
        else this.currentExpr += '(';
      } else if (act === 'bracket-close') {
        this.currentExpr += ')';
      } else if (act === 'percent') {
        let num = parseFloat(this.currentExpr) || 0;
        this.currentExpr = String(num / 100);
      }
    } catch (e) {
      this.currentExpr = 'შეცდომა';
    }
  }

  initConverter() {
    const catSelect = document.getElementById('convCategory');
    const fromSelect = document.getElementById('convFromUnit');
    const toSelect = document.getElementById('convToUnit');
    const input = document.getElementById('convInput');
    const output = document.getElementById('convOutput');

    if (!catSelect || !fromSelect || !toSelect || !input || !output) return;

    const units = {
      stress: {
        'მპა (MPa)': 1000000,
        'კპა (kPa)': 1000,
        'პა (Pa)': 1,
        'კნ/მ² (kN/m²)': 1000,
        'კგძ/სმ² (kgf/cm²)': 98066.5,
        'ტძ/მ² (tf/m²)': 9806.65
      },
      force: {
        'კნ (kN)': 1000,
        'ნ (N)': 1,
        'კგძ (kgf)': 9.80665,
        'ტძ (tf)': 9806.65
      },
      moment: {
        'კნ·მ (kN·m)': 1000,
        'ნ·მ (N·m)': 1,
        'კგძ·მ (kgf·m)': 9.80665,
        'კნ·სმ (kN·cm)': 10
      },
      length: {
        'მ (m)': 1,
        'სმ (cm)': 0.01,
        'მმ (mm)': 0.001,
        'კმ (km)': 1000
      }
    };

    const updateUnitOptions = () => {
      const cat = catSelect.value;
      const opts = Object.keys(units[cat] || {});
      fromSelect.innerHTML = opts.map(u => `<option value="${u}">${u}</option>`).join('');
      toSelect.innerHTML = opts.map((u, i) => `<option value="${u}" ${i === 1 ? 'selected' : ''}>${u}</option>`).join('');
      calcConvert();
    };

    const calcConvert = () => {
      const cat = catSelect.value;
      const val = parseFloat(input.value) || 0;
      const fromRate = units[cat] ? units[cat][fromSelect.value] : 1;
      const toRate = units[cat] ? units[cat][toSelect.value] : 1;
      const baseVal = val * fromRate;
      const res = baseVal / toRate;
      output.value = Number(res.toFixed(6));
    };

    catSelect.addEventListener('change', updateUnitOptions);
    fromSelect.addEventListener('change', calcConvert);
    toSelect.addEventListener('change', calcConvert);
    input.addEventListener('input', calcConvert);

    updateUnitOptions();
  }

  toggle(show) {
    if (!this.container) return;
    if (show === undefined) {
      this.container.classList.toggle('active');
    } else if (show) {
      this.container.classList.add('active');
    } else {
      this.container.classList.remove('active');
    }
  }
}

window.EngineeringCalculator = EngineeringCalculator;
