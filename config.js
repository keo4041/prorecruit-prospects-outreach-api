const admin = require('firebase-admin');
const countries = require('i18n-iso-countries');

// Register the languages you need (English and French)
// This loads the country name data for these languages
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));
countries.registerLocale(require("i18n-iso-countries/langs/fr.json"));
// --- Limits ---
const MAX_PROSPECTS_TO_ENRICH_PER_RUN = 2; // Adjust based on budget/time
const MAX_INITIAL_EMAILS_PER_RUN = 25;     // Target weekly send list size
const MAX_FOLLOWUP_EMAILS_PER_RUN = 75;   // Adjust as needed
const MAX_AI_EMAILS_PER_RUN = 15;

// --- Statuses ---
const EMAIL_STATUS = {
    PENDING: 'pending',
    VERIFIED: 'verified',
    FAILED: 'lookup_failed', // Consistent with task description
    PROCESSING: 'enrichment_inprogress', // Optional: To prevent re-processing during run
};

const OUTREACH_STATUS = {
    PENDING_UPLOAD: 'pending_upload', // Ready for first email
    ENRICHMENT_FAILED: 'enrichment_failed', // If enrichment fails badly
    SEQUENCE_STARTED: 'sequence_started', // First email sent
    FOLLOWUP_1: 'followup_1',           // Follow-up 1 sent
    FOLLOWUP_2: 'followup_2',           // Follow-up 2 sent (add more if needed)
    MOVED_TO_LEADS: 'move_to_leads',
    // Add terminal statuses mentioned in task (reply handling is manual/external for now)
    REPLIED_POSITIVE: 'replied_positive',
    REPLIED_NEGATIVE: 'replied_negative',
    MEETING_BOOKED: 'meeting_booked',
    UNSUBSCRIBED: 'unsubscribed',
    DO_NOT_CONTACT: 'do_not_contact', // For compliance
};

// --- Follow-up Logic ---
const FOLLOWUP_INTERVALS_DAYS = {
    [OUTREACH_STATUS.SEQUENCE_STARTED]: 2, // Send Followup 1, 2 days after initial send
    [OUTREACH_STATUS.FOLLOWUP_1]: 3,       // Send Followup 2, 3 days after Followup 1 (Total 5 days)
    // Add more intervals if needed
};

function getFollowupDueDate(lastContactedTimestamp, currentOutreachStatus) {
    if (!lastContactedTimestamp || !FOLLOWUP_INTERVALS_DAYS[currentOutreachStatus]) {
        return null;
    }
    const dueDate = new Date(lastContactedTimestamp.toDate()); // Convert Firestore Timestamp to JS Date
    dueDate.setDate(dueDate.getDate() + FOLLOWUP_INTERVALS_DAYS[currentOutreachStatus]);
    return admin.firestore.Timestamp.fromDate(dueDate);
}

// --- SendGrid Template IDs ---
// Structure: marketing_outreach_{type}_{lang}_{country/general}
const TEMPLATE_IDS = {
    initial: {
        en_US: process.env.SG_TPL_INIT_EN_US || 'marketing_outreach_initial_en_US', // Use env vars or defaults
        en_CA: process.env.SG_TPL_INIT_EN_CA || 'marketing_outreach_initial_en_CA',
        fr_CA: process.env.SG_TPL_INIT_FR_CA || 'marketing_outreach_initial_fr_CA',
        fr_FR: process.env.SG_TPL_INIT_FR_FR || 'marketing_outreach_initial_fr_FR',
        fr_BE: process.env.SG_TPL_INIT_FR_BE || 'marketing_outreach_initial_fr_BE',
        fr_CH: process.env.SG_TPL_INIT_FR_CH || 'marketing_outreach_initial_fr_CH',
        fr_general: process.env.SG_TPL_INIT_FR_GEN || 'marketing_outreach_initial_fr_general',
        en_general: process.env.SG_TPL_INIT_EN_GEN || 'marketing_outreach_initial_en_general',
    },
    followup: { // Assumes one followup template per locale for Day 3
        en_US: process.env.SG_TPL_FU_EN_US || 'marketing_outreach_followup_en_US',
        en_CA: process.env.SG_TPL_FU_EN_CA || 'marketing_outreach_followup_en_CA',
        fr_CA: process.env.SG_TPL_FU_FR_CA || 'marketing_outreach_followup_fr_CA',
        fr_FR: process.env.SG_TPL_FU_FR_FR || 'marketing_outreach_followup_fr_FR',
        fr_BE: process.env.SG_TPL_FU_FR_BE || 'marketing_outreach_followup_fr_BE',
        fr_CH: process.env.SG_TPL_FU_FR_CH || 'marketing_outreach_followup_fr_CH',
        fr_general: process.env.SG_TPL_FU_FR_GEN || 'marketing_outreach_followup_fr_general',
        en_general: process.env.SG_TPL_FU_EN_GEN || 'marketing_outreach_followup_en_general',
    }
};

function determineTemplateId(prospectData, emailType = 'initial') {
    const lang = prospectData.language?.toLowerCase() || 'en'; // Default to 'en'
    const country = getCountryISO2Code(prospectData.country) || 'GENERAL'; // Default to 'GENERAL'
    const key = `${lang}_${country}`;
    const generalKey = `${lang}_general`;

    const templateSet = TEMPLATE_IDS[emailType];
    if (!templateSet) {
        console.error(`Invalid email type for template lookup: ${emailType}`);
        return null;
    }

    // Try specific locale, then general locale, then null
    return templateSet[key] || templateSet[generalKey] || null;
}

/**
 * Transforms a full country name (English or French) into its ISO 3166-1 alpha-2 code.
 *
 * @param {string} countryName The full name of the country in English or French.
 * @returns {string | null} The uppercase 2-letter ISO code (e.g., 'US', 'FR')
 * or null if the country name is not found or invalid.
 */
function getCountryISO2Code(countryName) {
    // Basic validation for input
    if (typeof countryName !== 'string' || countryName.trim() === '') {
      console.warn(`Invalid input: Expected a non-empty string, received ${typeof countryName}`);
      return null;
    }
  
    // Trim whitespace for robustness
    const trimmedName = countryName.trim();
  
    // Try to get the code using the English name database
    // The library is generally case-insensitive for lookups.
    let isoCode = countries.getAlpha2Code(trimmedName, 'en');
  
    // If not found in English, try the French name database
    if (!isoCode) {
      isoCode = countries.getAlpha2Code(trimmedName, 'fr');
    }
  
    // Return the code if found, otherwise return null
    return isoCode || null;
  }


module.exports = {
    MAX_PROSPECTS_TO_ENRICH_PER_RUN,
    MAX_INITIAL_EMAILS_PER_RUN,
    MAX_FOLLOWUP_EMAILS_PER_RUN,
    MAX_AI_EMAILS_PER_RUN,
    EMAIL_STATUS,
    OUTREACH_STATUS,
    FOLLOWUP_INTERVALS_DAYS,
    getFollowupDueDate,
    determineTemplateId,
};