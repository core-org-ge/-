/**
 * საგამოცდო სისტემის მთავარი ინიციალიზაცია (CBT 100 კითხვა)
 */

document.addEventListener('DOMContentLoaded', () => {
  const structure = window.EXAM_STRUCTURE || {};
  const archQuestions = window.QUESTIONS_ARCH || [];
  const structQuestions = window.QUESTIONS_STRUCT || [];

  const engine = new ExamEngine(structure, archQuestions, structQuestions);
  const calculator = new EngineeringCalculator('calcModalContainer');
  const ui = new ExamUI(engine, calculator);

  window.__SIMULATOR = {
    engine,
    calculator,
    ui
  };

  console.log("საგამოცდო სისტემა ინიციალიზებულია წარმატებით (CBT 100-კითხვიანი სიმულატორი).");
});
