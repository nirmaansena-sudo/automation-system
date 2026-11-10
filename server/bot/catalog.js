// Business vocabulary (from nirmaansena.com): services, Jaipur zones,
// project types and timelines, with English/Hindi labels and keywords.
export const SERVICES = [
  { code: 'turnkey', en: 'New house (turnkey)', hi: 'नया मकान (टर्नकी)', den: 'Full construction, soil test to keys', dhi: 'मिट्टी जाँच से चाबी तक पूरा निर्माण',
    kw: ['turnkey', 'construction', 'construct', 'build', 'building', 'house', 'home', 'villa', 'bungalow', 'makan', 'makaan', 'ghar', 'nirman', 'मकान', 'घर', 'निर्माण', 'बनवाना', 'banwana', 'banana hai', 'civil'] },
  { code: 'architecture', en: 'Architect & 3D design', hi: 'आर्किटेक्ट व 3D डिज़ाइन', den: 'JDA drawings, 3D elevation, Vastu', dhi: 'JDA नक्शा, 3D एलिवेशन, वास्तु',
    kw: ['architect', 'design', 'naksha', 'map', 'plan', 'drawing', '3d', 'elevation', 'vastu', 'jda', 'नक्शा', 'डिज़ाइन', 'डिजाइन', 'आर्किटेक्ट', 'वास्तु'] },
  { code: 'interiors', en: 'Interiors', hi: 'इंटीरियर', den: 'Home, office & cafe interiors', dhi: 'घर, ऑफिस व कैफे इंटीरियर',
    kw: ['interior', 'interiors', 'modular', 'kitchen', 'wardrobe', 'furniture', 'false ceiling', 'decor', 'इंटीरियर', 'किचन', 'फर्नीचर'] },
  { code: 'renovation', en: 'Repair / renovation', hi: 'मरम्मत / रिनोवेशन', den: 'Floor addition, waterproofing, repairs', dhi: 'मंज़िल जोड़ना, वॉटरप्रूफिंग, मरम्मत',
    kw: ['repair', 'renovation', 'renovate', 'waterproof', 'waterproofing', 'leak', 'leakage', 'seepage', 'seelan', 'marammat', 'crack', 'मरम्मत', 'सीलन', 'लीकेज', 'रिपेयर'] },
  { code: 'labour', en: 'Labour & contractors', hi: 'मिस्त्री व ठेकेदार', den: 'Masons, carpenters, plumbers, tiles', dhi: 'मिस्त्री, बढ़ई, प्लंबर, टाइल',
    kw: ['labour', 'labor', 'mistri', 'mason', 'carpenter', 'plumber', 'electrician', 'thekedar', 'contractor', 'majdoor', 'mazdoor', 'tile', 'मिस्त्री', 'मजदूर', 'ठेकेदार', 'प्लंबर'] },
  { code: 'specialized', en: 'Paint, POP, marble…', hi: 'पेंट, POP, मार्बल…', den: 'Paint, gypsum, marble, UPVC, solar', dhi: 'पेंट, जिप्सम, मार्बल, UPVC, सोलर',
    kw: ['paint', 'painting', 'pop', 'gypsum', 'marble', 'polish', 'upvc', 'solar', 'putty', 'पेंट', 'मार्बल', 'सोलर'] },
  { code: 'pmc', en: 'Supervision / PMC', hi: 'सुपरविज़न / PMC', den: 'Independent quality audits', dhi: 'स्वतंत्र गुणवत्ता जाँच',
    kw: ['pmc', 'supervision', 'supervisor', 'quality', 'audit', 'inspection', 'nigrani', 'निगरानी', 'सुपरविज़न'] },
  { code: 'materials', en: 'Building materials', hi: 'बिल्डिंग मटेरियल', den: 'Cement, TMT steel, bricks, Kota stone', dhi: 'सीमेंट, सरिया, ईंट, कोटा स्टोन',
    kw: ['cement', 'sariya', 'saria', 'steel', 'tmt', 'brick', 'bricks', 'eent', 'int', 'material', 'kota stone', 'sand', 'bajri', 'सीमेंट', 'सरिया', 'ईंट', 'मटेरियल', 'बजरी'] },
];
export const SERVICE_CODES = SERVICES.map((s) => s.code);

export const NATURES = [
  { code: 'new_build', en: 'New house / villa', hi: 'नया मकान / विला', kw: ['new house', 'new home', 'villa', 'bungalow', 'naya', 'नया'] },
  { code: 'floor_addition', en: 'Floor addition', hi: 'मंज़िल जोड़ना', kw: ['floor', 'manzil', 'upar', 'first floor', 'second floor', 'मंज़िल', 'मंजिल', 'ऊपर'] },
  { code: 'commercial', en: 'Shop / office / cafe', hi: 'दुकान / ऑफिस / कैफे', kw: ['shop', 'office', 'cafe', 'showroom', 'commercial', 'restaurant', 'dukan', 'दुकान', 'ऑफिस'] },
  { code: 'apartment_interior', en: 'Flat interior', hi: 'फ्लैट इंटीरियर', kw: ['flat', 'apartment', 'फ्लैट'] },
  { code: 'repair', en: 'Repair / waterproofing', hi: 'मरम्मत / वॉटरप्रूफिंग', kw: ['repair', 'waterproof', 'leak', 'seepage', 'marammat', 'मरम्मत'] },
  { code: 'other', en: 'Other', hi: 'अन्य', kw: [] },
];

export const WINDOWS = [
  { code: 'immediate', en: 'Immediately', hi: 'तुरंत', kw: ['immediate', 'immediately', 'asap', 'urgent', 'turant', 'abhi', 'jaldi', 'तुरंत', 'अभी', 'जल्दी'] },
  { code: 'within_15_days', en: 'Within 15 days', hi: '15 दिन में', kw: ['15 days', '15 din', 'two weeks', '2 weeks', 'this month', '15 दिन'] },
  { code: 'planning_30_plus', en: '30+ days (planning)', hi: '30+ दिन (प्लानिंग)', kw: ['month', 'months', 'planning', 'later', 'baad', 'mahine', 'बाद', 'महीने', 'प्लानिंग'] },
];

export const ZONES_DEFAULT = [
  { code: 'vaishali', name: 'Vaishali Nagar', name_hi: 'वैशाली नगर', lat: 26.9115, lng: 75.7396, kw: ['vaishali', 'वैशाली', 'chitrakoot', 'gandhi path', 'queens road'] },
  { code: 'mansarovar', name: 'Mansarovar', name_hi: 'मानसरोवर', lat: 26.8505, lng: 75.7628, kw: ['mansarovar', 'mansrovar', 'मानसरोवर', 'shipra path', 'patel marg', 'vt road'] },
  { code: 'jhotwara', name: 'Jhotwara / Kalwar Road', name_hi: 'झोटवाड़ा / कालवाड़ रोड', lat: 26.955, lng: 75.74, kw: ['jhotwara', 'kalwar', 'govind nagar', 'झोटवाड़ा', 'कालवाड़', 'niwaru', 'khatipura'] },
  { code: 'jagatpura', name: 'Jagatpura', name_hi: 'जगतपुरा', lat: 26.8285, lng: 75.8236, kw: ['jagatpura', 'जगतपुरा', 'sitapura', 'goner', 'mahal road'] },
  { code: 'malviya', name: 'Malviya Nagar', name_hi: 'मालवीय नगर', lat: 26.8549, lng: 75.8243, kw: ['malviya', 'मालवीय', 'jawahar circle', 'gaurav tower'] },
  { code: 'cscheme', name: 'Raja Park / C-Scheme', name_hi: 'राजा पार्क / सी-स्कीम', lat: 26.9, lng: 75.81, kw: ['raja park', 'c-scheme', 'c scheme', 'adarsh nagar', 'bapu nagar', 'lal kothi', 'tilak nagar', 'राजा पार्क', 'सी स्कीम'] },
  { code: 'ajmer_rd', name: 'Ajmer Road / Bhankrota', name_hi: 'अजमेर रोड / भांकरोटा', lat: 26.877, lng: 75.68, kw: ['ajmer road', 'bhankrota', 'अजमेर रोड', 'भांकरोटा', 'mahindra sez', 'kamla nehru nagar'] },
  { code: 'vidhyadhar', name: 'Vidhyadhar Nagar', name_hi: 'विद्याधर नगर', lat: 26.958, lng: 75.778, kw: ['vidhyadhar', 'vidyadhar', 'विद्याधर', 'sikar road', 'shastri nagar', 'murlipura'] },
  { code: 'sanganer', name: 'Sanganer / Tonk Road', name_hi: 'सांगानेर / टोंक रोड', lat: 26.82, lng: 75.8, kw: ['sanganer', 'tonk road', 'सांगानेर', 'टोंक रोड', 'durgapura', 'pratap nagar', 'muhana', 'airport'] },
  { code: 'other_jaipur', name: 'Other Jaipur area', name_hi: 'जयपुर में अन्य', lat: 26.9124, lng: 75.7873, kw: [] },
  { code: 'outside', name: 'Outside Jaipur', name_hi: 'जयपुर से बाहर', lat: null, lng: null, kw: [] },
];

/** More Jaipur localities → help decide "other Jaipur" vs "outside Jaipur". */
export const JAIPUR_LOCALITIES = ['jaipur', 'जयपुर', 'sodala', 'shyam nagar', 'bani park', 'civil lines', 'tonk phatak', 'gopalpura', 'nirman nagar',
  'bais godam', 'sirsi road', 'panchyawala', 'hasanpura', 'delhi road', 'amer', 'agra road', 'transport nagar', 'bagru', 'chomu', 'mahapura',
  'kanota', 'mahesh nagar', 'barkat nagar', 'triveni nagar', 'swej farm', 'new sanganer road', 'jamdoli', 'jhalana', 'mansarovar extension',
  'heerapura', 'benad', 'kukas', 'bassi', 'chaksu', 'phagi', 'sanganer', 'ramganj', 'johari bazar', 'chandpole', 'nahargarh', 'kalwara', 'dahar ka balaji', 'vatika'];

export const label = (list, code, lang = 'en') => { const x = list.find((i) => i.code === code); return x ? (lang === 'hi' ? x.hi : x.en) : code || ''; };
export const serviceLabel = (code, lang) => label(SERVICES, code, lang);
export const natureLabel = (code, lang) => label(NATURES, code, lang);
export const windowLabel = (code, lang) => label(WINDOWS, code, lang);
export const COMMERCIAL_MODELS = { design_only: 'Design only', labour_only: 'Labour only', with_material: 'With material', turnkey: 'Turnkey', pmc: 'PMC / supervision' };
export const SERVICE_TYPES = { design: 'Design', construction: 'Construction', interiors: 'Interiors', renovation: 'Renovation', supervision: 'Supervision', materials: 'Materials', labour: 'Labour' };
