import { createClient } from '@supabase/supabase-js';

// The publishable key is designed for browser use. Row-level security in the
// database is what limits its permissions; never put a service-role key here.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz';

export const supabase = createClient(supabaseUrl, supabaseKey);
