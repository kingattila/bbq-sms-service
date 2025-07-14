import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';

// Railway automatically injects environment variables — no need for dotenv
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
console.log('✅ ENV CHECK:', {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID
});
async function sendSMS(to, message) {
  try {
    const result = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`✅ SMS sent to ${to}: ${result.sid}`);
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${to}:`, err.message);
  }
}

async function checkQueueAndNotify() {
  console.log('🔍 Checking for waiting queue entries...');

  const { data: entries, error } = await supabase
    .from('queue_entries')
    .select('*')
    .eq('status', 'waiting')
    .eq('notified', false);

  if (error) {
    console.error('❌ Error fetching entries:', error.message);
    return;
  }

  if (!entries || entries.length === 0) {
    console.log('✅ No entries to notify.');
    return;
  }

  for (const entry of entries) {
    const { id, customer_name, phone_number, requested_barber_id, shop_id, joined_at } = entry;

    if (!phone_number) continue;

    // 1️⃣ Get barbers and shop config
    const { data: barbers } = await supabase
      .from('barbers')
      .select('id, average_cut_time')
      .eq('shop_id', shop_id);

    const { data: shop } = await supabase
      .from('barbershops')
      .select('notify_threshold')
      .eq('id', shop_id)
      .single();

    if (!barbers || barbers.length === 0 || !shop) {
      console.warn(`⚠️ Skipping ${customer_name} — missing barber/shop data.`);
      continue;
    }

    let shouldNotify = false;

    // 2️⃣ If specific barber selected
    if (requested_barber_id) {
      const { data: queueForBarber } = await supabase
        .from('queue_entries')
        .select('id')
        .eq('shop_id', shop_id)
        .eq('status', 'waiting')
        .eq('requested_barber_id', requested_barber_id)
        .order('joined_at', { ascending: true });

      if (queueForBarber && queueForBarber[0]?.id === id) {
        shouldNotify = true;
      }
    }

    // 3️⃣ If "any barber" selected
    else {
      const { data: fullQueue } = await supabase
        .from('queue_entries')
        .select('*')
        .eq('shop_id', shop_id)
        .eq('status', 'waiting')
        .order('joined_at', { ascending: true });

      const position = fullQueue.findIndex((e) => e.id === id);

      if (position === 0) {
        shouldNotify = true;
      } else {
        const avgCutTime = Math.min(...barbers.map((b) => b.average_cut_time || 15));
        const estimatedWait = avgCutTime * position;
        if (estimatedWait <= shop.notify_threshold) {
          shouldNotify = true;
        }
      }
    }

    if (shouldNotify) {
      await sendSMS(phone_number, `Hi ${customer_name}, you're up next! Please return to the barbershop.`);
      await supabase.from('queue_entries').update({ notified: true }).eq('id', id);
      console.log(`✅ Marked ${customer_name} as notified.`);
    } else {
      console.log(`⏳ Skipped ${customer_name} — not yet ready to notify.`);
    }
  }
}

checkQueueAndNotify().then(() => process.exit());