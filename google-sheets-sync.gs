/**
 * Google Sheets ავტომატური სინქრონიზაციის სკრიპტი
 * არქიტექტორებისა და ინჟინრების საგამოცდო სისტემისთვის
 * 
 * ინსტრუქცია (სულ 1-2 წუთი):
 * 1. შედით https://sheets.google.com და შექმენით ახალი ცარიელი Google ცხრილი.
 * 2. ზედა მენიუში დააჭირეთ: Extensions (გაფართოებები) -> Apps Script.
 * 3. წაშალეთ იქ რაც წერია და ჩასვით ეს მთლიანი კოდი.
 * 4. ზედა მარჯვენა კუთხეში დააჭირეთ: Deploy (განთავსება) -> New deployment (ახალი განთავსება).
 * 5. აირჩიეთ ტიპი (Gear icon): Web app (ვებ აპლიკაცია).
 * 6. "Who has access" (ვის აქვს წვდომა) ჩამოშალეთ და აირჩიეთ: "Anyone" (ყველას).
 * 7. დააჭირეთ Deploy -> დააკოპირეთ მოცემული Web App URL.
 * 8. შედით საიტზე, გახსენით "ადმინ პანელი" (პინი 1234), ჩასვით ეს ლინკი და დააჭირეთ "შენახვას".
 * 
 * ამის შემდეგ, ნებისმიერი კანდიდატი როდესაც დაასრულებს ტესტს, მონაცემები 
 * მომენტალურად გაჩნდება თქვენს Google ცხრილში!
 */

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getActiveSheet();
    
    // თუ პირველი ხაზი ცარიელია, ვქმნით ლამაზ სათაურებს
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "თარიღი და დრო",
        "კანდიდატის სახელი",
        "Gmail მისამართი",
        "საგამოცდო პროფილი",
        "რეჟიმი",
        "ქულა (100-დან)",
        "პროცენტი",
        "სტატუსი",
        "დრო (წუთი)",
        "სესიის ID"
      ]);
      
      // სათაურების ფორმატირება (მუქი ფონტით და ლურჯი ფონით)
      var headerRange = sheet.getRange(1, 1, 1, 10);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#1a56db");
      headerRange.setFontColor("#ffffff");
    }
    
    var data = JSON.parse(e.postData.contents);
    
    // მონაცემების დამატება
    sheet.appendRow([
      data.date,
      data.candidateName,
      data.candidateEmail,
      data.profileTitle,
      data.mode,
      data.score,
      data.percent + "%",
      data.passed ? "ჩაბარებულია ✅" : "ჩაჭრილია ❌",
      data.timeSpentMinutes,
      data.id
    ]);
    
    // ბოლო სტრიქონის გაფერადება (მწვანე თუ ჩააბარა, წითელი თუ ჩაიჭრა)
    var lastRow = sheet.getLastRow();
    var statusCell = sheet.getRange(lastRow, 8);
    if (data.passed) {
      statusCell.setBackground("#def7ec");
      statusCell.setFontColor("#03543f");
    } else {
      statusCell.setBackground("#fde8e8");
      statusCell.setFontColor("#9b1c1c");
    }
    
    return ContentService
      .createTextOutput(JSON.stringify({ status: "success" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
