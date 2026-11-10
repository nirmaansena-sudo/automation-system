import { all, one, tx } from '../db/index.js';
import { bad } from '../lib/http.js';
import { config } from '../config.js';
import { getSettings, saveSettings } from '../core/base.js';
import { validateSettings } from '../lib/settings-validation.js';
import { providerStatus } from '../whatsapp/providers.js';
import { aiStatus } from '../bot/ai.js';
import { detectIntents, matchFaq, extractServices } from '../bot/nlu.js';

const policyKeys = ['human_sla_min','human_release_min','human_auto_resume','bot_max_per_hour','bot_unknown_before_handoff','ai_confidence_threshold'];
export function registerAutomationDashboard(r) {
  const manager = {auth:'dashboard',roles:['owner','manager']};
  r.get('/api/whatsapp/automation',manager,()=>{
    const settings=getSettings(), provider=providerStatus();
    return {provider, ai:aiStatus(), publicHttps:config.publicUrl.startsWith('https://'),
      policy:Object.fromEntries(policyKeys.map(k=>[k,settings[k]])),
      activeFaqs:one('SELECT COUNT(*) n FROM faqs WHERE active=1').n,
      approvedTemplates:one("SELECT COUNT(*) n FROM wa_templates WHERE status='approved'").n,
      humanWaiting:one("SELECT COUNT(*) n FROM conversations WHERE mode='human' AND needs_attention=1").n,
      botConversations:one("SELECT COUNT(*) n FROM conversations WHERE mode='bot'").n,
      lastInbound:one("SELECT MAX(received_at) at FROM inbound_events WHERE kind='message'").at,
      providerCredentialsConfigured:provider.ready && provider.provider!=='simulator'};
  });
  r.patch('/api/whatsapp/automation',manager,ctx=>tx(()=>{
    const body=ctx.body;
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!policyKeys.includes(k))) throw bad('Only conversation policy settings can be changed here');
    validateSettings(body); saveSettings(body,`user:${ctx.user.id}`); return {ok:true};
  }));
  // A local dry run: no message is enqueued and no AI/provider is contacted.
  r.post('/api/whatsapp/automation/check-answer',manager,ctx=>{
    const text=ctx.body?.text;
    if (typeof text!=='string' || !text.trim() || text.length>2000) throw bad('Enter a question of 1–2,000 characters');
    const intents=detectIntents(text), language=ctx.body.language==='hi'?'hi':'en';
    if (intents.has('human') || intents.has('emergency') || intents.has('complaint')) return {action:'human',explanation:'This question is routed to the team for review.',answer:null};
    const faq=matchFaq(text,all('SELECT * FROM faqs WHERE active=1'));
    if (faq) return {action:'approved_answer',question:faq.question,answer:language==='hi'&&faq.answer_hi?faq.answer_hi:faq.answer_en,explanation:'Matched an active approved answer using local keyword rules.'};
    const services=extractServices(text);
    if (services.length) return {action:'enquiry',services,answer:null,explanation:'Starts the guided enquiry flow to collect site details and arrange a visit.'};
    if (intents.has('greeting') || intents.has('menu')) return {action:'menu',answer:null,explanation:'Shows the service menu; existing verified clients see their project menu.'};
    return {action:'clarify_then_human',answer:null,explanation:'No approved rule answer matched. The live bot asks for clarification; repeated uncertainty goes to the team. Optional AI can help understand wording when configured.'};
  });
}
