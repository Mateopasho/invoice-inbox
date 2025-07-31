import 'dotenv/config.js';  // Loads environment variables from .env file
import { fetchEmails } from './api/fetchEmails.js'; // Correct path to fetchEmails.js

(async () => {
  try {
    console.log('📥 Running fetchEmails...');
    const results = await fetchEmails();  // Calls the fetchEmails function to test the process
    console.log('✅ Done. Processed files:', results);
  } catch (err) {
    console.error('❌ Test Error:', err.message);
  }
})();
