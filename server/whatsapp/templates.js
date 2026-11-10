// WhatsApp message templates (needed outside the 24-hour customer service
// window). Submit these in WhatsApp Manager, then mark them "approved" in
// Dashboard → Messages → Templates. Rules followed: no variable at the start
// or end of a body, variables numbered in order of appearance.
import { all, run } from '../db/index.js';
import { nowIso } from '../lib/util.js';

export const TEMPLATES = [
  {
    name: 'ns_visit_offer', category: 'UTILITY', to: 'architect', params: ['lead ref', 'services', 'area', 'proposed time', 'reply-by time'],
    en: { body: 'New site visit request {{1}} for {{2}} in {{3}}. Proposed time: {{4}}. Please accept or decline by {{5}} using the buttons below.', buttons: ['Accept', 'Decline'] },
    hi: { body: 'नया साइट विज़िट अनुरोध {{1}}: {{2}}, क्षेत्र {{3}}। प्रस्तावित समय: {{4}}। कृपया {{5}} तक नीचे दिए बटन से स्वीकार या अस्वीकार करें।', buttons: ['स्वीकार', 'अस्वीकार'] },
  },
  {
    name: 'ns_visit_confirm_request', category: 'UTILITY', to: 'client', params: ['client name', 'architect', 'area', 'time'],
    en: { body: 'Hello {{1}}, {{2}} can visit your site in {{3}} on {{4}}. Please confirm the visit using the buttons below.', buttons: ['Confirm', 'Another time', 'Cancel'] },
    hi: { body: 'नमस्ते {{1}}, {{2}} आपकी साइट ({{3}}) पर {{4}} को आ सकते हैं। कृपया नीचे दिए बटन से विज़िट की पुष्टि करें।', buttons: ['पुष्टि करें', 'दूसरा समय', 'रद्द करें'] },
  },
  {
    name: 'ns_visit_confirmed', category: 'UTILITY', to: 'client', params: ['visit ref', 'time', 'architect'],
    en: { body: 'Your site visit {{1}} is confirmed for {{2}} with {{3}}. They will call you before arriving. Reply to this message to reschedule.', buttons: [] },
    hi: { body: 'आपकी साइट विज़िट {{1}} {{2}} को {{3}} के साथ पक्की है। वे आने से पहले आपको कॉल करेंगे। समय बदलने के लिए इस संदेश का जवाब दें।', buttons: [] },
  },
  {
    name: 'ns_visit_details', category: 'UTILITY', to: 'architect', params: ['visit ref', 'time', 'client name', 'client phone', 'address', 'map link'],
    en: { body: 'Visit {{1}} confirmed for {{2}}. Client: {{3}}, phone {{4}}. Address: {{5}}. Map: {{6}} . Please call the client before you leave.', buttons: [] },
    hi: { body: 'विज़िट {{1}} {{2}} के लिए पक्की है। क्लाइंट: {{3}}, फ़ोन {{4}}। पता: {{5}}। नक्शा: {{6}} । निकलने से पहले क्लाइंट को कॉल करें।', buttons: [] },
  },
  {
    name: 'ns_visit_reminder', category: 'UTILITY', to: 'client/architect', params: ['visit ref', 'time', 'place'],
    en: { body: 'Reminder: site visit {{1}} is scheduled for {{2}} at {{3}}. Reply to this message if you need any change.', buttons: [] },
    hi: { body: 'याद दिलाना: साइट विज़िट {{1}} {{2}} को {{3}} पर तय है। कोई बदलाव हो तो इस संदेश का जवाब दें।', buttons: [] },
  },
  {
    name: 'ns_daily_update', category: 'UTILITY', to: 'client', params: ['project ref', 'summary', 'link'],
    en: { body: "Today's update for your project {{1}}: {{2}}. See photos and progress here: {{3}} . Thank you for building with Nirmaan Sena.", buttons: [] },
    hi: { body: 'आपके प्रोजेक्ट {{1}} का आज का अपडेट: {{2}}। फ़ोटो और प्रगति यहाँ देखें: {{3}} । निर्माण सेना के साथ निर्माण के लिए धन्यवाद।', buttons: [] },
  },
  {
    name: 'ns_quotation_ready', category: 'UTILITY', to: 'client', params: ['quote ref', 'version', 'service', 'total', 'valid until', 'link'],
    en: { body: 'Your quotation {{1}} (version {{2}}) for {{3}} is ready. Total {{4}}, valid until {{5}}. View it here: {{6}} . Use the buttons to accept or request changes.', buttons: ['Accept', 'Request changes'] },
    hi: { body: 'आपका कोटेशन {{1}} (वर्ज़न {{2}}) {{3}} के लिए तैयार है। कुल {{4}}, {{5}} तक मान्य। यहाँ देखें: {{6}} । स्वीकार करने या बदलाव के लिए बटन दबाएँ।', buttons: ['स्वीकार करें', 'बदलाव चाहिए'] },
  },
  {
    name: 'ns_milestone_review', category: 'UTILITY', to: 'client', params: ['milestone', 'project ref', 'link'],
    en: { body: 'Milestone {{1}} is complete at your project {{2}}. Please review the photos here: {{3}} and approve or raise a concern using the buttons.', buttons: ['Approve', 'Raise concern'] },
    hi: { body: 'चरण {{1}} आपके प्रोजेक्ट {{2}} में पूरा हो गया है। कृपया फ़ोटो यहाँ देखें: {{3}} और बटन से स्वीकृति दें या समस्या बताएँ।', buttons: ['स्वीकृति दें', 'समस्या बताएँ'] },
  },
  {
    name: 'ns_invoice', category: 'UTILITY', to: 'client', params: ['invoice ref', 'project ref', 'amount', 'for', 'due date', 'how to pay'],
    en: { body: 'Invoice {{1}} for project {{2}}: {{3}} for {{4}}, due on {{5}}. {{6}} Thank you.', buttons: [] },
    hi: { body: 'इनवॉइस {{1}}, प्रोजेक्ट {{2}}: {{3}} ({{4}}), देय तिथि {{5}}। {{6}} धन्यवाद।', buttons: [] },
  },
  {
    name: 'ns_payment_reminder', category: 'UTILITY', to: 'client', params: ['project ref', 'amount', 'for', 'due date', 'how to pay'],
    en: { body: 'Payment reminder for project {{1}}: {{2}} for {{3}} is due on {{4}}. {{5}} Thank you.', buttons: [] },
    hi: { body: 'प्रोजेक्ट {{1}} का भुगतान: {{2}} ({{3}}) की देय तिथि {{4}} है। {{5}} धन्यवाद।', buttons: [] },
  },
  {
    name: 'ns_followup_enquiry', category: 'UTILITY', to: 'client', params: ['client name', 'lead ref'],
    en: { body: 'Hello {{1}}, your enquiry {{2}} with Nirmaan Sena is still open. Would you like to continue booking your site visit?', buttons: ['Continue', 'Not now'] },
    hi: { body: 'नमस्ते {{1}}, निर्माण सेना में आपकी पूछताछ {{2}} अभी खुली है। क्या आप साइट विज़िट बुक करना जारी रखना चाहेंगे?', buttons: ['जारी रखें', 'अभी नहीं'] },
  },
  {
    name: 'ns_website_enquiry', category: 'UTILITY', to: 'client', params: ['client name', 'lead ref'],
    en: { body: 'Hello {{1}}, thank you for your enquiry {{2}} on nirmaansena.com. Tap Continue to share your site location and book a site visit.', buttons: ['Continue'] },
    hi: { body: "नमस्ते {{1}}, nirmaansena.com पर आपकी पूछताछ {{2}} के लिए धन्यवाद। साइट लोकेशन भेजने और विज़िट बुक करने के लिए 'जारी रखें' दबाएँ।", buttons: ['जारी रखें'] },
  },
  {
    name: 'ns_project_welcome', category: 'UTILITY', to: 'client', params: ['project ref', 'booking amount', 'link'],
    en: { body: 'Welcome to Nirmaan Sena! Your project {{1}} has been created. Booking amount {{2}}. Track your project here: {{3}} . We will keep you updated on WhatsApp.', buttons: [] },
    hi: { body: 'निर्माण सेना में आपका स्वागत है! आपका प्रोजेक्ट {{1}} बन गया है। बुकिंग राशि {{2}}। प्रोजेक्ट यहाँ देखें: {{3}} । हम आपको WhatsApp पर अपडेट देते रहेंगे।', buttons: [] },
  },
  {
    name: 'ns_change_request', category: 'UTILITY', to: 'client', params: ['project ref', 'change', 'cost impact', 'time impact'],
    en: { body: 'A change to your project {{1}} needs your approval: {{2}}. Cost impact {{3}}, time impact {{4}}. Please approve or reject using the buttons.', buttons: ['Approve', 'Reject'] },
    hi: { body: 'आपके प्रोजेक्ट {{1}} में एक बदलाव के लिए आपकी स्वीकृति चाहिए: {{2}}। लागत प्रभाव {{3}}, समय प्रभाव {{4}}। कृपया बटन से स्वीकार या अस्वीकार करें।', buttons: ['स्वीकार', 'अस्वीकार'] },
  },
  {
    name: 'ns_client_update', category: 'UTILITY', to: 'client', params: ['subject', 'update'],
    en: { body: 'Update from Nirmaan Sena about {{1}}: {{2}}. Reply to this message if you have any questions.', buttons: [] },
    hi: { body: 'निर्माण सेना की ओर से {{1}} के बारे में अपडेट: {{2}}। कोई सवाल हो तो इस संदेश का जवाब दें।', buttons: [] },
  },
  {
    name: 'ns_staff_alert', category: 'UTILITY', to: 'staff', params: ['alert'],
    en: { body: 'Nirmaan Sena alert: {{1}}. Please open the app for details.', buttons: [] },
    hi: { body: 'निर्माण सेना अलर्ट: {{1}}। विवरण के लिए ऐप खोलें।', buttons: [] },
  },
  {
    name: 'ns_attendance_reminder', category: 'UTILITY', to: 'staff', params: ['name', 'date'],
    en: { body: 'Hi {{1}}, you have not checked in today ({{2}}). Please check in from the app or apply for leave.', buttons: [] },
    hi: { body: 'नमस्ते {{1}}, आपने आज ({{2}}) चेक-इन नहीं किया है। कृपया ऐप से चेक-इन करें या छुट्टी के लिए आवेदन करें।', buttons: [] },
  },
];

/** Insert missing templates; never overwrites approval status chosen by the owner. */
export function seedTemplates() {
  const existing = new Set(all('SELECT name || ? || language k FROM wa_templates', '|').map((r) => r.k));
  for (const t of TEMPLATES) {
    for (const lang of ['en', 'hi']) {
      if (existing.has(`${t.name}|${lang}`)) {
        run('UPDATE wa_templates SET body=?, buttons=?, params=?, category=? WHERE name=? AND language=? AND status=?', t[lang].body, JSON.stringify(t[lang].buttons.map((b) => ({ type: 'quick_reply', text: b }))), JSON.stringify(t.params), t.category, t.name, lang, 'draft');
        continue;
      }
      run('INSERT INTO wa_templates(name, language, category, body, params, buttons, status, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        t.name, lang, t.category, t[lang].body, JSON.stringify(t.params), JSON.stringify(t[lang].buttons.map((b) => ({ type: 'quick_reply', text: b }))), 'draft', nowIso());
    }
  }
}
