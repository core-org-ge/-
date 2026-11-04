/**
 * არქიტექტორებისა და ინჟინერ-მშენებლების სერტიფიცირების საგამოცდო სისტემა
 * Google Apps Script Web App Controller (საქართველოს მთავრობის №134 დადგენილება)
 * 
 * ინსტრუქცია (სულ 1-2 წუთი):
 * 1. გახსენით https://sheets.google.com და შექმენით ახალი ცარიელი Google ცხრილი.
 * 2. ზედა მენიუში დააჭირეთ: Extensions (გაფართოებები) -> Apps Script.
 * 3. ფაილში "Code.gs" წაშალეთ რაც წერია და ჩასვით ეს მთლიანი კოდი.
 * 4. მარცხენა მენიუში დააჭირეთ "+" (Add a file) -> HTML, დაარქვით ზუსტად "Index" და ჩასვით Index.html ფაილის შიგთავსი.
 * 5. ზედა მარჯვენა კუთხეში დააჭირეთ: Deploy (განთავსება) -> New deployment (ახალი განთავსება).
 * 6. აირჩიეთ ტიპი (Gear icon): Web app.
 *    - Description: საგამოცდო სისტემა
 *    - Execute as: Me (თქვენი მეილი)
 *    - Who has access: Anyone
 * 7. დააჭირეთ "Deploy" -> მიიღებთ მზა ვებ-აპლიკაციის ბმულს (Web App URL).
 * 8. ეს ბმული გაუგზავნეთ კანდიდატებს!
 */

function doGet(e) {
  var output = HtmlService.createHtmlOutputFromFile('Index');
  output.setTitle('არქიტექტორებისა და ინჟინერ-მშენებლების საგამოცდო სისტემა (№134 დადგენილება)');
  output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return output;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var res = saveExamResult(data);
    return ContentService
      .createTextOutput(JSON.stringify(res))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getUserInfo() {
  try {
    var email = Session.getActiveUser().getEmail();
    return {
      email: email || '',
      isLoggedIn: !!email
    };
  } catch(e) {
    return { email: '', isLoggedIn: false };
  }
}

function saveExamResult(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("საგამოცდო შედეგები");
    
    // თუ ფურცელი არ არსებობს, ვქმნით
    if (!sheet) {
      sheet = ss.insertSheet("საგამოცდო შედეგები");
    }
    
    // თუ პირველი ხაზი ცარიელია, ვქმნით ლამაზ სათაურებს
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "თარიღი და დრო",
        "კანდიდატის სახელი და გვარი",
        "Gmail / ელ-ფოსტა",
        "ტელეფონი",
        "საგამოცდო პროფილი",
        "რეჟიმი",
        "ქულა (100-დან)",
        "პროცენტი",
        "სტატუსი",
        "დახარჯული დრო (წთ)",
        "ქვეთავების დეტალები",
        "სესიის ID"
      ]);
      
      var headerRange = sheet.getRange(1, 1, 1, 12);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#1a56db");
      headerRange.setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }
    
    var subStatsText = "";
    if (data.subStats && data.subStats.length > 0) {
      subStatsText = data.subStats.map(function(s) {
        return s.name + ": " + s.correct + "/" + s.total + " (" + s.percent + "% - " + (s.passed ? "ჩაბარდა" : "ჩაიჭრა") + ")";
      }).join("; \n");
    }
    
    sheet.appendRow([
      data.date || new Date().toLocaleString('ka-GE', { timeZone: 'Asia/Tbilisi' }),
      data.candidateName || 'კანდიდატი',
      data.candidateEmail || 'არ არის მითითებული',
      data.candidatePhone || '',
      data.profileTitle,
      data.mode,
      data.score,
      data.percent + "%",
      data.passed ? "ჩაბარებულია ✅" : "ჩაჭრილია ❌",
      data.timeSpentMinutes,
      subStatsText,
      data.id
    ]);
    
    // ბოლო სტრიქონის სტატუსის უჯრის გაფერადება
    var lastRow = sheet.getLastRow();
    var statusCell = sheet.getRange(lastRow, 9);
    if (data.passed) {
      statusCell.setBackground("#def7ec");
      statusCell.setFontColor("#03543f");
      statusCell.setFontWeight("bold");
    } else {
      statusCell.setBackground("#fde8e8");
      statusCell.setFontColor("#9b1c1c");
      statusCell.setFontWeight("bold");
    }
    
    return { success: true, row: lastRow };
  } catch(err) {
    return { success: false, error: err.message };
  }
}

function getJournalFromSheet() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("საგამოცდო შედეგები");
    if (!sheet || sheet.getLastRow() <= 1) return [];
    
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 12).getValues();
    var result = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var r = rows[i];
      result.push({
        date: r[0],
        candidateName: r[1],
        candidateEmail: r[2],
        candidatePhone: r[3],
        profileTitle: r[4],
        mode: r[5],
        score: r[6],
        percent: String(r[7]).replace('%', ''),
        passed: String(r[8]).indexOf('ჩაბარებულია') !== -1,
        timeSpentMinutes: r[9],
        subStatsText: r[10],
        id: r[11]
      });
    }
    return result;
  } catch(e) {
    return [];
  }
}
