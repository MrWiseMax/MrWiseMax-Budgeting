// ============================================================
// MrWiseMax — Supabase Client
// ⚠️  Replace the two values below with your project credentials
//     Supabase Dashboard → Settings → API
// ============================================================

const SUPABASE_URL      = 'https://ezfzlwaeymmvmazvozyx.supabase.co';   // e.g. https://xxxx.supabase.co
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV6Znpsd2FleW1tdm1henZvenl4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NjI4NDksImV4cCI6MjA5NDIzODg0OX0.pXIJFXEp_AHkVblHycRh_ER_ti0iOGYPQN0dcVp6iZk';      // public anon key

window.db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
