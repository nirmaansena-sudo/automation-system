# WhatsApp message templates

WhatsApp only allows **pre-approved templates** when the person has not written to you in the last 24 hours
(for example reminders, architect offers, daily updates and payment reminders). Everything else is sent as a
normal reply inside the 24-hour window.

**How to submit:** WhatsApp Manager → *Message templates* → *Create template* → Category **Utility** →
use exactly the **name** below → language *English* (en) and again *Hindi* (hi) → paste the body →
add the buttons as **Quick reply** buttons → add the sample values → submit.
When Meta approves a template, open the dashboard → *Messages → Templates* and set it to **approved**.

Rules already followed: no variable at the very start or end of the text, variables numbered in the order
they appear. Meta may still re-categorise a template; if one is rejected,
shorten it slightly and resubmit.

Until a template is approved, the system creates a *“Send manually”* task instead of failing silently.

| # | Template | Sent to | Buttons |
|---|---|---|---|
| 1 | `ns_visit_offer` | architect | Accept · Decline |
| 2 | `ns_visit_confirm_request` | client | Confirm · Another time · Cancel |
| 3 | `ns_visit_confirmed` | client | — |
| 4 | `ns_visit_details` | architect | — |
| 5 | `ns_visit_reminder` | client/architect | — |
| 6 | `ns_daily_update` | client | — |
| 7 | `ns_quotation_ready` | client | Accept · Request changes |
| 8 | `ns_milestone_review` | client | Approve · Raise concern |
| 9 | `ns_invoice` | client | — |
| 10 | `ns_payment_reminder` | client | — |
| 11 | `ns_followup_enquiry` | client | Continue · Not now |
| 12 | `ns_website_enquiry` | client | Continue |
| 13 | `ns_project_welcome` | client | — |
| 14 | `ns_change_request` | client | Approve · Reject |
| 15 | `ns_client_update` | client | — |
| 16 | `ns_staff_alert` | staff | — |
| 17 | `ns_attendance_reminder` | staff | — |

---

## `ns_visit_offer`

Category: **UTILITY** · Sent to: architect

**Variables:** {{1}} = lead ref · {{2}} = services · {{3}} = area · {{4}} = proposed time · {{5}} = reply-by time

**English (en)**

> New site visit request {{1}} for {{2}} in {{3}}. Proposed time: {{4}}. Please accept or decline by {{5}} using the buttons below.

Quick-reply buttons: `Accept`, `Decline`

**Hindi (hi)**

> नया साइट विज़िट अनुरोध {{1}}: {{2}}, क्षेत्र {{3}}। प्रस्तावित समय: {{4}}। कृपया {{5}} तक नीचे दिए बटन से स्वीकार या अस्वीकार करें।

Quick-reply buttons: `स्वीकार`, `अस्वीकार`

**Sample values for Meta's review:** {{1}} `NS-JPR-2026-0042` · {{2}} `New house (turnkey)` · {{3}} `Vaishali Nagar` · {{4}} `Sat, 8 Nov, 11:00 am` · {{5}} `3:30 pm`

---

## `ns_visit_confirm_request`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = client name · {{2}} = architect · {{3}} = area · {{4}} = time

**English (en)**

> Hello {{1}}, {{2}} can visit your site in {{3}} on {{4}}. Please confirm the visit using the buttons below.

Quick-reply buttons: `Confirm`, `Another time`, `Cancel`

**Hindi (hi)**

> नमस्ते {{1}}, {{2}} आपकी साइट ({{3}}) पर {{4}} को आ सकते हैं। कृपया नीचे दिए बटन से विज़िट की पुष्टि करें।

Quick-reply buttons: `पुष्टि करें`, `दूसरा समय`, `रद्द करें`

**Sample values for Meta's review:** {{1}} `Deepak` · {{2}} `Ar. Rahul Mehta` · {{3}} `Vaishali Nagar` · {{4}} `Sat, 8 Nov, 11:00 am`

---

## `ns_visit_confirmed`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = visit ref · {{2}} = time · {{3}} = architect

**English (en)**

> Your site visit {{1}} is confirmed for {{2}} with {{3}}. They will call you before arriving. Reply to this message to reschedule.

**Hindi (hi)**

> आपकी साइट विज़िट {{1}} {{2}} को {{3}} के साथ पक्की है। वे आने से पहले आपको कॉल करेंगे। समय बदलने के लिए इस संदेश का जवाब दें।

**Sample values for Meta's review:** {{1}} `NS-VIS-2026-0017` · {{2}} `Sat, 8 Nov, 11:00 am` · {{3}} `Ar. Rahul Mehta`

---

## `ns_visit_details`

Category: **UTILITY** · Sent to: architect

**Variables:** {{1}} = visit ref · {{2}} = time · {{3}} = client name · {{4}} = client phone · {{5}} = address · {{6}} = map link

**English (en)**

> Visit {{1}} confirmed for {{2}}. Client: {{3}}, phone {{4}}. Address: {{5}}. Map: {{6}} . Please call the client before you leave.

**Hindi (hi)**

> विज़िट {{1}} {{2}} के लिए पक्की है। क्लाइंट: {{3}}, फ़ोन {{4}}। पता: {{5}}। नक्शा: {{6}} । निकलने से पहले क्लाइंट को कॉल करें।

**Sample values for Meta's review:** {{1}} `NS-VIS-2026-0017` · {{2}} `Sat, 8 Nov, 11:00 am` · {{3}} `Deepak` · {{4}} `+91 98123 45678` · {{5}} `Plot 12, Gandhi Path, Vaishali Nagar` · {{6}} `https://www.google.com/maps/search/?api=1&query=26.91,75.74`

---

## `ns_visit_reminder`

Category: **UTILITY** · Sent to: client/architect

**Variables:** {{1}} = visit ref · {{2}} = time · {{3}} = place

**English (en)**

> Reminder: site visit {{1}} is scheduled for {{2}} at {{3}}. Reply to this message if you need any change.

**Hindi (hi)**

> याद दिलाना: साइट विज़िट {{1}} {{2}} को {{3}} पर तय है। कोई बदलाव हो तो इस संदेश का जवाब दें।

**Sample values for Meta's review:** {{1}} `NS-VIS-2026-0017` · {{2}} `Sat, 8 Nov, 11:00 am` · {{3}} `Vaishali Nagar`

---

## `ns_daily_update`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = project ref · {{2}} = summary · {{3}} = link

**English (en)**

> Today's update for your project {{1}}: {{2}}. See photos and progress here: {{3}} . Thank you for building with Nirmaan Sena.

**Hindi (hi)**

> आपके प्रोजेक्ट {{1}} का आज का अपडेट: {{2}}। फ़ोटो और प्रगति यहाँ देखें: {{3}} । निर्माण सेना के साथ निर्माण के लिए धन्यवाद।

**Sample values for Meta's review:** {{1}} `NS-PRJ-2026-004` · {{2}} `Brickwork 2nd floor 75%, 12 workers on site` · {{3}} `https://ops.example.com/p/abc123`

---

## `ns_quotation_ready`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = quote ref · {{2}} = version · {{3}} = service · {{4}} = total · {{5}} = valid until · {{6}} = link

**English (en)**

> Your quotation {{1}} (version {{2}}) for {{3}} is ready. Total {{4}}, valid until {{5}}. View it here: {{6}} . Use the buttons to accept or request changes.

Quick-reply buttons: `Accept`, `Request changes`

**Hindi (hi)**

> आपका कोटेशन {{1}} (वर्ज़न {{2}}) {{3}} के लिए तैयार है। कुल {{4}}, {{5}} तक मान्य। यहाँ देखें: {{6}} । स्वीकार करने या बदलाव के लिए बटन दबाएँ।

Quick-reply buttons: `स्वीकार करें`, `बदलाव चाहिए`

**Sample values for Meta's review:** {{1}} `NS-QT-2026-0011` · {{2}} `2` · {{3}} `Construction · Turnkey` · {{4}} `₹46,72,800` · {{5}} `17 Nov 2026` · {{6}} `https://ops.example.com/p/abc123`

---

## `ns_milestone_review`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = milestone · {{2}} = project ref · {{3}} = link

**English (en)**

> Milestone {{1}} is complete at your project {{2}}. Please review the photos here: {{3}} and approve or raise a concern using the buttons.

Quick-reply buttons: `Approve`, `Raise concern`

**Hindi (hi)**

> चरण {{1}} आपके प्रोजेक्ट {{2}} में पूरा हो गया है। कृपया फ़ोटो यहाँ देखें: {{3}} और बटन से स्वीकृति दें या समस्या बताएँ।

Quick-reply buttons: `स्वीकृति दें`, `समस्या बताएँ`

**Sample values for Meta's review:** {{1}} `Roof slab` · {{2}} `NS-PRJ-2026-004` · {{3}} `https://ops.example.com/p/abc123`

---

## `ns_invoice`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = invoice ref · {{2}} = project ref · {{3}} = amount · {{4}} = for · {{5}} = due date · {{6}} = how to pay

**English (en)**

> Invoice {{1}} for project {{2}}: {{3}} for {{4}}, due on {{5}}. {{6}} Thank you.

**Hindi (hi)**

> इनवॉइस {{1}}, प्रोजेक्ट {{2}}: {{3}} ({{4}}), देय तिथि {{5}}। {{6}} धन्यवाद।

**Sample values for Meta's review:** {{1}} `NS-INV-2026-0031` · {{2}} `NS-PRJ-2026-004` · {{3}} `₹7,00,920` · {{4}} `Roof slab` · {{5}} `20 Nov 2026` · {{6}} `Bank transfer / UPI details will be shared by our accounts team.`

---

## `ns_payment_reminder`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = project ref · {{2}} = amount · {{3}} = for · {{4}} = due date · {{5}} = how to pay

**English (en)**

> Payment reminder for project {{1}}: {{2}} for {{3}} is due on {{4}}. {{5}} Thank you.

**Hindi (hi)**

> प्रोजेक्ट {{1}} का भुगतान: {{2}} ({{3}}) की देय तिथि {{4}} है। {{5}} धन्यवाद।

**Sample values for Meta's review:** {{1}} `NS-PRJ-2026-004` · {{2}} `₹7,00,920` · {{3}} `Roof slab` · {{4}} `20 Nov 2026` · {{5}} `Bank transfer / UPI details will be shared by our accounts team.`

---

## `ns_followup_enquiry`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = client name · {{2}} = lead ref

**English (en)**

> Hello {{1}}, your enquiry {{2}} with Nirmaan Sena is still open. Would you like to continue booking your site visit?

Quick-reply buttons: `Continue`, `Not now`

**Hindi (hi)**

> नमस्ते {{1}}, निर्माण सेना में आपकी पूछताछ {{2}} अभी खुली है। क्या आप साइट विज़िट बुक करना जारी रखना चाहेंगे?

Quick-reply buttons: `जारी रखें`, `अभी नहीं`

**Sample values for Meta's review:** {{1}} `Deepak` · {{2}} `NS-JPR-2026-0042`

---

## `ns_website_enquiry`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = client name · {{2}} = lead ref

**English (en)**

> Hello {{1}}, thank you for your enquiry {{2}} on nirmaansena.com. Tap Continue to share your site location and book a site visit.

Quick-reply buttons: `Continue`

**Hindi (hi)**

> नमस्ते {{1}}, nirmaansena.com पर आपकी पूछताछ {{2}} के लिए धन्यवाद। साइट लोकेशन भेजने और विज़िट बुक करने के लिए 'जारी रखें' दबाएँ।

Quick-reply buttons: `जारी रखें`

**Sample values for Meta's review:** {{1}} `Deepak` · {{2}} `NS-JPR-2026-0042`

---

## `ns_project_welcome`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = project ref · {{2}} = booking amount · {{3}} = link

**English (en)**

> Welcome to Nirmaan Sena! Your project {{1}} has been created. Booking amount {{2}}. Track your project here: {{3}} . We will keep you updated on WhatsApp.

**Hindi (hi)**

> निर्माण सेना में आपका स्वागत है! आपका प्रोजेक्ट {{1}} बन गया है। बुकिंग राशि {{2}}। प्रोजेक्ट यहाँ देखें: {{3}} । हम आपको WhatsApp पर अपडेट देते रहेंगे।

**Sample values for Meta's review:** {{1}} `NS-PRJ-2026-004` · {{2}} `₹4,67,280` · {{3}} `https://ops.example.com/p/abc123`

---

## `ns_change_request`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = project ref · {{2}} = change · {{3}} = cost impact · {{4}} = time impact

**English (en)**

> A change to your project {{1}} needs your approval: {{2}}. Cost impact {{3}}, time impact {{4}}. Please approve or reject using the buttons.

Quick-reply buttons: `Approve`, `Reject`

**Hindi (hi)**

> आपके प्रोजेक्ट {{1}} में एक बदलाव के लिए आपकी स्वीकृति चाहिए: {{2}}। लागत प्रभाव {{3}}, समय प्रभाव {{4}}। कृपया बटन से स्वीकार या अस्वीकार करें।

Quick-reply buttons: `स्वीकार`, `अस्वीकार`

**Sample values for Meta's review:** {{1}} `NS-PRJ-2026-004` · {{2}} `Add balcony on first floor` · {{3}} `₹85,000` · {{4}} `6 days`

---

## `ns_client_update`

Category: **UTILITY** · Sent to: client

**Variables:** {{1}} = subject · {{2}} = update

**English (en)**

> Update from Nirmaan Sena about {{1}}: {{2}}. Reply to this message if you have any questions.

**Hindi (hi)**

> निर्माण सेना की ओर से {{1}} के बारे में अपडेट: {{2}}। कोई सवाल हो तो इस संदेश का जवाब दें।

**Sample values for Meta's review:** {{1}} `NS-VIS-2026-0017` · {{2}} `our architect is running a little late`

---

## `ns_staff_alert`

Category: **UTILITY** · Sent to: staff

**Variables:** {{1}} = alert

**English (en)**

> Nirmaan Sena alert: {{1}}. Please open the app for details.

**Hindi (hi)**

> निर्माण सेना अलर्ट: {{1}}। विवरण के लिए ऐप खोलें।

**Sample values for Meta's review:** {{1}} `site report pending for NS-VIS-2026-0017`

---

## `ns_attendance_reminder`

Category: **UTILITY** · Sent to: staff

**Variables:** {{1}} = name · {{2}} = date

**English (en)**

> Hi {{1}}, you have not checked in today ({{2}}). Please check in from the app or apply for leave.

**Hindi (hi)**

> नमस्ते {{1}}, आपने आज ({{2}}) चेक-इन नहीं किया है। कृपया ऐप से चेक-इन करें या छुट्टी के लिए आवेदन करें।

**Sample values for Meta's review:** {{1}} `Suresh` · {{2}} `2026-11-08`
