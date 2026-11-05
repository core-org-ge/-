/**
 * საგამოცდო ძრავა (Exam Engine v2.0 — ISO/IEC 17024 & დადგენილება №134)
 * 
 * უზრუნველყოფს:
 * 1. სტატიკური ბანკისა და პარამეტრული გენერატორის სრული პულის გაერთიანებას ყველა ქვეთავში.
 * 2. 100%-იან დაცვას კითხვების გამეორებისგან (დუბლირების სრული გამორიცხვა).
 * 3. დადგენილება №41-ისა (თავი III–XXI) და №732-ის (თავი III–XI) სტრატიფიცირებულ განაწილებას.
 * 4. სესიებს შორის კითხვების როტაციას (წინა ტესტში გამოყენებული კითხვების ჩანაცვლებას ახლით).
 * 5. პასუხების ვარიანტების (A, B, C, D) სრულ რანდომიზაციას.
 * 6. დადგენილება №134-ის მკაცრ ქვეთავობრივ შეფასებას (70% სპეციალისტი / 75% ექსპერტი).
 */

class ExamEngine {
  constructor(structure, archQuestions, structQuestions) {
    this.structure = structure || window.EXAM_STRUCTURE;
    this.archBank = archQuestions || window.QUESTIONS_ARCH || [];
    this.structBank = structQuestions || window.QUESTIONS_STRUCT || [];
    this.currentExam = null;
    this.timerInterval = null;
    this.onTick = null;
    this.onTimeUp = null;
  }

  /**
   * ახალი საგამოცდო სესიის ინიციალიზაცია
   * @param {string} profileId - arch_main | arch_expert | struct_main | struct_expert
   * @param {string} mode - 'exam' | 'study'
   */
  startExam(profileId, mode = 'exam', difficulty = 'easy') {
    const profile = this.structure.profiles[profileId];
    if (!profile) throw new Error(`უცნობი პროფილი: ${profileId}`);

    const syllabi = this.structure.syllabi || this.structure.curricula;
    const curriculum = syllabi[profile.field];
    const bank = profile.field === 'architecture' ? this.archBank : this.structBank;

    const diff = (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) ? difficulty : 'easy';
    const diffTitles = { easy: 'მარტივი', medium: 'საშუალო', hard: 'რთული' };

    const selectedQuestions = this._generateQuotaExam(curriculum, bank, profile.field, diff);
    const durationMinutes = profile.time_minutes || (this.structure.exam_meta && this.structure.exam_meta.duration_minutes) || 180;

    this.currentExam = {
      profileId,
      profile,
      mode,
      difficulty: diff,
      difficultyTitle: diffTitles[diff],
      curriculum,
      questions: selectedQuestions,
      userAnswers: {}, // { index: [selectedOptionIndices] }
      flagged: new Set(),
      currentIndex: 0,
      startTime: Date.now(),
      durationMinutes,
      remainingSeconds: durationMinutes * 60, // 180 * 60 = 10800 წმ
      isFinished: false,
      result: null
    };

    if (mode === 'exam') {
      this._startTimer();
    }

    return this.currentExam;
  }

  /**
   * აგენერირებს 100 უნიკალურ კითხვას ქვეთავების ოფიციალური კვოტების მკაცრი დაცვითა და სირთულის მიხედვით
   */
  _generateQuotaExam(curriculum, bank, field, difficulty = 'easy') {
    const examQuestions = [];
    const globalUsedTexts = new Set();
    const recentKeys = this._getRecentTemplateKeys(field);
    const newlyUsedKeys = [];

    // სირთულეების სპეციფიკური ბანკები
    const isArch = field === 'architecture';
    const hardBank = isArch ? (window.QUESTIONS_ARCH_HARD || []) : (window.QUESTIONS_STRUCT_HARD || []);
    const mediumBank = isArch ? (window.QUESTIONS_ARCH_MEDIUM || []) : (window.QUESTIONS_STRUCT_MEDIUM || []);

    curriculum.chapters.forEach(chapter => {
      const chapterQuestions = [];

      chapter.subchapters.forEach(sub => {
        const quota = sub.quota;
        if (!quota || quota <= 0) return;

        // 1. სტატიკური კითხვები შესაბამისი სირთულის მიხედვით პრიორიტეტით
        let targetStatic = [];
        let fallbackStatic = [];

        if (difficulty === 'hard') {
          targetStatic = hardBank.filter(q => q.subchapter_id === sub.id);
          fallbackStatic = mediumBank.filter(q => q.subchapter_id === sub.id).concat(bank.filter(q => q.subchapter_id === sub.id));
        } else if (difficulty === 'medium') {
          targetStatic = mediumBank.filter(q => q.subchapter_id === sub.id);
          fallbackStatic = bank.filter(q => q.subchapter_id === sub.id);
        } else {
          // easy - არსებული საბაზისო კითხვები
          targetStatic = bank.filter(q => q.subchapter_id === sub.id);
          fallbackStatic = [];
        }

        const staticPool = [...targetStatic, ...fallbackStatic].map(q => ({
          ...JSON.parse(JSON.stringify(q)),
          templateKey: q.templateKey || q.id,
          difficulty: q.difficulty || (targetStatic.includes(q) ? difficulty : 'easy')
        }));

        // 2. დინამიური/პარამეტრული გენერატორის სრული უნიკალური პული ამ ქვეთავისთვის
        let dynamicPool = [];
        if (window.QuestionGenerator && typeof window.QuestionGenerator.generateSubchapterPool === 'function') {
          dynamicPool = window.QuestionGenerator.generateSubchapterPool(sub.id, difficulty) || [];
        }

        // 3. გაერთიანება და მკაცრი დედუპლიკაცია ტექსტისა და templateKey-ს მიხედვით
        // პრიორიტეტი მივანიჭოთ target სირთულის კითხვებს
        const combinedRaw = [...dynamicPool, ...staticPool];
        const uniquePool = [];
        const localSeenKeys = new Set();

        combinedRaw.forEach(q => {
          if (!q || !q.question) return;
          const normText = q.question.trim().replace(/\s+/g, ' ');
          const tKey = q.templateKey || normText;
          if (!globalUsedTexts.has(normText) && !localSeenKeys.has(tKey)) {
            localSeenKeys.add(tKey);
            uniquePool.push(q);
          }
        });

        // 4. კითხვების შერჩევა (უპირატესობა ენიჭება არჩეული სირთულის + წინა ტესტში გამოუყენებელ კითხვებს)
        const chosen = this._selectSubchapterQuestions(uniquePool, quota, recentKeys, difficulty);

        chosen.forEach(rawQ => {
          const normText = rawQ.question.trim().replace(/\s+/g, ' ');
          globalUsedTexts.add(normText);
          if (rawQ.templateKey) newlyUsedKeys.push(rawQ.templateKey);

          const prepared = this._shuffleQuestionOptions(rawQ);
          prepared.chapterName = chapter.name;
          prepared.subchapterName = sub.name;
          prepared.difficulty = rawQ.difficulty || difficulty;
          prepared.difficultyTitle = prepared.difficulty === 'hard' ? 'რთული' : (prepared.difficulty === 'medium' ? 'საშუალო' : 'მარტივი');
          chapterQuestions.push(prepared);
        });
      });

      // თავის შიგნით კითხვების დამატებითი არევა, რათა ყოველ ჯერზე განსხვავებული თანმიმდევრობით დაიწყოს
      this._shuffleArray(chapterQuestions);
      examQuestions.push(...chapterQuestions);
    });

    this._saveRecentTemplateKeys(field, newlyUsedKeys);
    return examQuestions;
  }

  /**
   * ირჩევს quota რაოდენობის კითხვას უნიკალური პულიდან:
   * - პრიორიტეტს ანიჭებს არჩეული სირთულის კითხვებს
   * - ითვალისწინებს chapter_tag სტრატიფიკაციას
   * - პრიორიტეტს ანიჭებს წინა ტესტში გამოუყენებელ კითხვებს
   */
  _selectSubchapterQuestions(uniquePool, quota, recentKeys, difficulty = 'easy') {
    if (uniquePool.length <= quota) {
      return this._shuffleArray([...uniquePool]);
    }

    // პირველ რიგში დავახარისხოთ სირთულის მიხედვით (target difficulty პირველად)
    const matchDiff = uniquePool.filter(q => q.difficulty === difficulty);
    const otherDiff = uniquePool.filter(q => q.difficulty !== difficulty);

    const sortPool = [...this._shuffleArray(matchDiff), ...this._shuffleArray(otherDiff)];

    // დავყოთ ახალ (unseen) და წინა ტესტში ნანახ (seen) კითხვებად
    const unseen = sortPool.filter(q => !recentKeys.has(q.templateKey));
    const seen = sortPool.filter(q => recentKeys.has(q.templateKey));
    const prioritizedPool = [...unseen, ...seen];

    // თუ კითხვებს აქვთ chapter_tag (მაგ. arch_4_1 ან arch_4_2), ჯერ თითოეული თავიდან ავიღოთ მინიმუმ 1–2 კითხვა
    const byTag = {};
    const untagged = [];
    prioritizedPool.forEach(q => {
      if (q.chapter_tag) {
        if (!byTag[q.chapter_tag]) byTag[q.chapter_tag] = [];
        byTag[q.chapter_tag].push(q);
      } else {
        untagged.push(q);
      }
    });

    const tagKeys = this._shuffleArray(Object.keys(byTag));
    if (tagKeys.length === 0) {
      return prioritizedPool.slice(0, quota);
    }

    const chosen = [];
    const chosenSet = new Set();

    // თითოეული ტეგიდან რიგრიგობით (Round-Robin) ვიღებთ კითხვებს კვოტის შევსებამდე
    let addedInRound = true;
    while (chosen.length < quota && addedInRound) {
      addedInRound = false;
      for (const tag of tagKeys) {
        if (chosen.length >= quota) break;
        const list = byTag[tag];
        if (list && list.length > 0) {
          const item = list.shift();
          chosen.push(item);
          chosenSet.add(item);
          addedInRound = true;
        }
      }
    }

    // თუ კიდევ დარჩა კვოტა შესავსები, ვავსებთ untagged კითხვებით
    for (const item of untagged) {
      if (chosen.length >= quota) break;
      if (!chosenSet.has(item)) {
        chosen.push(item);
        chosenSet.add(item);
      }
    }

    return this._shuffleArray(chosen);
  }

  _getRecentTemplateKeys(field) {
    try {
      const raw = sessionStorage.getItem(`exam_recent_keys_${field}`);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch (e) {
      return new Set();
    }
  }

  _saveRecentTemplateKeys(field, keys) {
    try {
      sessionStorage.setItem(`exam_recent_keys_${field}`, JSON.stringify(keys));
    } catch (e) {}
  }

  /**
   * ურევს კითხვის სავარაუდო პასუხებს და ანახლებს სწორი პასუხების ინდექსებს
   */
  _shuffleQuestionOptions(rawQuestion) {
    const q = JSON.parse(JSON.stringify(rawQuestion));
    const indices = q.options.map((_, i) => i);
    this._shuffleArray(indices);

    const newOptions = indices.map(oldIdx => q.options[oldIdx]);
    const newCorrect = q.correct
      .map(oldCorrIdx => indices.indexOf(oldCorrIdx))
      .sort((a, b) => a - b);

    q.options = newOptions;
    q.correct = newCorrect;
    return q;
  }

  _shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * პასუხის დაფიქსირება მიმდინარე კითხვაზე
   */
  selectAnswer(questionIndex, optionIndex) {
    if (!this.currentExam || this.currentExam.isFinished) return;
    const q = this.currentExam.questions[questionIndex];
    const req = q.required_choices || 1;

    if (!this.currentExam.userAnswers[questionIndex]) {
      this.currentExam.userAnswers[questionIndex] = [];
    }

    let current = [...this.currentExam.userAnswers[questionIndex]];

    if (req === 1) {
      current = [optionIndex];
    } else {
      const pos = current.indexOf(optionIndex);
      if (pos > -1) {
        current.splice(pos, 1);
      } else {
        if (current.length < req) {
          current.push(optionIndex);
        } else {
          current.shift();
          current.push(optionIndex);
        }
      }
    }

    current.sort((a, b) => a - b);
    this.currentExam.userAnswers[questionIndex] = current;
  }

  toggleFlag(questionIndex) {
    if (!this.currentExam) return;
    if (this.currentExam.flagged.has(questionIndex)) {
      this.currentExam.flagged.delete(questionIndex);
    } else {
      this.currentExam.flagged.add(questionIndex);
    }
  }

  /**
   * გამოცდის დასრულება და შედეგების დეტალური გამოთვლა №134 დადგენილების მიხედვით
   */
  finishExam() {
    if (!this.currentExam || this.currentExam.isFinished) return null;
    this._stopTimer();
    this.currentExam.isFinished = true;

    const { questions, userAnswers, profile, curriculum } = this.currentExam;
    const threshold = profile.passing_score_subchapter; // 0.70 ან 0.75

    const subStats = {};
    curriculum.chapters.forEach(ch => {
      ch.subchapters.forEach(sub => {
        subStats[sub.id] = {
          id: sub.id,
          name: sub.name,
          chapterName: ch.name,
          quota: sub.quota,
          total: 0,
          correct: 0,
          score: 0,
          passed: true
        };
      });
    });

    let totalEarned = 0;
    const evaluatedQuestions = questions.map((q, idx) => {
      const userSel = userAnswers[idx] || [];
      const corrSel = q.correct || [];

      const isCorrect =
        userSel.length === corrSel.length &&
        userSel.every((val, i) => val === corrSel[i]);

      if (subStats[q.subchapter_id]) {
        subStats[q.subchapter_id].total += 1;
        if (isCorrect) {
          subStats[q.subchapter_id].correct += 1;
        }
      }

      if (isCorrect) totalEarned += 1;

      return {
        ...q,
        index: idx,
        userSelection: userSel,
        correctSelection: corrSel,
        isCorrect
      };
    });

    let allSubchaptersPassed = true;
    const subchaptersReport = Object.values(subStats).map(st => {
      if (st.total > 0) {
        st.score = st.correct / st.total;
        st.passed = (st.score + 1e-9) >= threshold;
        if (!st.passed) {
          allSubchaptersPassed = false;
        }
      }
      return st;
    });

    const overallScore = questions.length > 0 ? totalEarned / questions.length : 0;
    const overallThreshold = profile.passing_score_overall || threshold;
    const overallPassed = (overallScore + 1e-9) >= overallThreshold;
    const finalPassed = overallPassed && allSubchaptersPassed;

    const totalDurSec = (this.currentExam.durationMinutes || profile.time_minutes || 180) * 60;
    const timeSpentSeconds = Math.max(0, totalDurSec - this.currentExam.remainingSeconds);

    this.currentExam.result = {
      profileTitle: profile.title,
      profileId: profile.id,
      threshold,
      totalQuestions: questions.length,
      totalEarned,
      overallScore,
      overallPassed,
      allSubchaptersPassed,
      finalPassed,
      timeSpentSeconds,
      subStats: subchaptersReport,
      evaluatedQuestions
    };

    return this.currentExam.result;
  }

  _startTimer() {
    this._stopTimer();
    this.timerInterval = setInterval(() => {
      if (!this.currentExam || this.currentExam.isFinished) {
        this._stopTimer();
        return;
      }
      this.currentExam.remainingSeconds -= 1;
      if (this.onTick) {
        this.onTick(this.currentExam.remainingSeconds);
      }
      if (this.currentExam.remainingSeconds <= 0) {
        this._stopTimer();
        this.finishExam();
        if (this.onTimeUp) {
          this.onTimeUp(this.currentExam.result);
        }
      }
    }, 1000);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
}

window.ExamEngine = ExamEngine;
