const axios = require('axios');
const admin = require('firebase-admin');
const { EMAIL_STATUS } = require('./config');

const PROXYCURL_API_KEY = process.env.PROXYCURL_API_KEY_PATH;
const PROXYCURL_HEADERS = { 'Authorization': `Bearer ${PROXYCURL_API_KEY}` };
const PERSON_PROFILE_URL = 'https://nubela.co/proxycurl/api/v2/linkedin';
const WORK_EMAIL_LOOKUP_URL = 'https://nubela.co/proxycurl/api/linkedin/profile/email'; // Adjust if different

/**
 * Enriches a prospect using Proxycurl.
 * @param {object} prospectData - Prospect data from Firestore.
 * @param {object} logger - Logger instance.
 * @returns {Promise<object|null>} Enrichment data or null if failed.
 */
async function enrichProspectWithProxycurl(prospectData, logger) {
    if (!PROXYCURL_API_KEY) {
        logger.error('PROXYCURL_API_KEY is not set.');
        return { success: false, error: 'Missing API Key', updateData: { emailStatus: EMAIL_STATUS.FAILED, enrichmentTimestamp: admin.firestore.Timestamp.now(), enrichmentSuccess: false } };
    }

    const linkedinUrl = prospectData.linkedinUrl;
    if (!linkedinUrl) {
        logger.warn(`Prospect ${prospectData.id} missing linkedinUrl. Skipping enrichment.`);
        return { success: false, error: 'Missing LinkedIn URL', updateData: { emailStatus: EMAIL_STATUS.FAILED, enrichmentTimestamp: admin.firestore.Timestamp.now(), enrichmentSuccess: false } }; // Mark as failed
    }

    const updateData = {};
    let personData = null;
    let workEmailData = null;
    let success = true;
    let finalEmailStatus = EMAIL_STATUS.FAILED; // Default to failed

    try {
        // --- 1. Get Person Profile ---
        logger.info(`Enriching profile for: ${linkedinUrl}`);
        const personProfileParams = { url: linkedinUrl };
        const personResponse = await axios.get(PERSON_PROFILE_URL, {
            headers: PROXYCURL_HEADERS,
            params: personProfileParams,
            timeout: 30000, // 30 second timeout
        });
        personData = personResponse.data;
        logger.info(personData)

        // Basic checks on personData
        if (!personData || personData.detail === 'Profile not found') {
            logger.warn(`Proxycurl profile not found for ${linkedinUrl}.`);
             // Don't stop here, maybe email lookup still works? Or mark as failed? Let's mark failed for now.
             return { success: false, error: 'Profile not found', updateData: { emailStatus: EMAIL_STATUS.FAILED, enrichmentTimestamp: admin.firestore.Timestamp.now(), enrichmentSuccess: false } };
        }

        // Map fields carefully, handle nulls/missing data from Proxycurl
        updateData.firstName = personData.first_name || prospectData.firstName || ""; // Use existing if proxycurl fails
        updateData.lastName = personData.last_name || prospectData.lastName || "";
        updateData.jobTitle = personData.occupation || prospectData.jobTitle || "";
        updateData.industry = personData.industry || prospectData.industry || "";
        updateData.country = personData.country_full_name || prospectData.country || "";
        updateData.city = personData.city || prospectData.city || "";
        updateData.linkedinUrl = linkedinUrl;
        updateData.enrichmentSuccess = true; // Mark as successful
        updateData.companyName = personData.current_company?.name || personData.company || prospectData.company || ""; // Check current_company first
        updateData.location = personData.city && personData.country_full_name ? `${personData.city}, ${personData.country_full_name}` : personData.location || prospectData.location || "";
        // updateData.companyDomain = personData.current_company?.link ? new URL(personData.current_company.link).hostname.replace(/^www\./, '') : prospectData.hsEmailDomain || ""; // Infer domain if possible

         // --- 2. Get Work Email ---
         // Proxycurl might require company domain, provide if available
         const companyDomain = prospectData.hsEmailDomain || (personData.current_company?.link ? new URL(personData.current_company.link).hostname.replace(/^www\./, '') : null);
         logger.info(`Looking up work email for: ${linkedinUrl} (Domain: ${companyDomain || 'Not Provided'})`);
         const emailLookupParams = {
             linkedin_profile_url: linkedinUrl,
             ...(companyDomain && { company_domain: companyDomain }), // Conditionally add domain
             // Add other params like 'title', 'location' if needed by the endpoint
         };

        const emailResponse = await axios.get(WORK_EMAIL_LOOKUP_URL, {
            headers: PROXYCURL_HEADERS,
            params: emailLookupParams,
            timeout: 45000, // Longer timeout for email lookup
        });
        workEmailData = emailResponse.data;

        // --- 3. Process Results ---
        if (workEmailData && workEmailData.email && workEmailData.status === 'verified') {
            updateData.workEmail = workEmailData.email;
            updateData.emailStatus = EMAIL_STATUS.VERIFIED;
            finalEmailStatus = EMAIL_STATUS.VERIFIED; // Success!
            logger.info(`Verified email found for ${linkedinUrl}: ${workEmailData.email}`);
        } else {
            logger.warn(`Work email lookup failed or not verified for ${linkedinUrl}. Status: ${workEmailData?.status}, Email: ${workEmailData?.email}`);
             // Keep enrichment data from profile step, but mark email as failed.
            updateData.emailStatus = EMAIL_STATUS.FAILED;
            finalEmailStatus = EMAIL_STATUS.FAILED;
        }

    } catch (error) {
        success = false;
        logger.error(`Proxycurl API error during enrichment for ${linkedinUrl}:`, error.message);
        if (error.response) {
            logger.error(`Proxycurl Error Status: ${error.response.status}`);
            logger.error(`Proxycurl Error Body:`, error.response.data);
            // Handle specific errors like 401 (auth), 404 (not found), 429 (rate limit)
            if (error.response.status === 404) {
                 updateData.emailStatus = EMAIL_STATUS.FAILED; // Mark as failed if profile/email not found
                 updateData.enrichmentTimestamp = admin.firestore.Timestamp.now(); // Update timestamp
                 updateData.enrichmentSuccess = false; // Mark as failed
                 finalEmailStatus = EMAIL_STATUS.FAILED;
            } else {
                // For other errors (rate limits, server errors), maybe retry later? For now, mark failed.
                updateData.emailStatus = EMAIL_STATUS.FAILED;
                updateData.enrichmentTimestamp = admin.firestore.Timestamp.now(); // Update timestamp
                updateData.enrichmentSuccess = false; // Mark as failed
                finalEmailStatus = EMAIL_STATUS.FAILED;
            }
        } else {
             // Network errors etc.
             updateData.emailStatus = EMAIL_STATUS.FAILED; // Mark failed on network issues too
             updateData.enrichmentTimestamp = admin.firestore.Timestamp.now(); // Update timestamp
             updateData.enrichmentSuccess = false; // Mark as failed
             finalEmailStatus = EMAIL_STATUS.FAILED;
        }
    }

    updateData.enrichmentTimestamp = admin.firestore.Timestamp.now(); // Always update timestamp

    return { success, updateData, error: success ? null : 'Proxycurl API Error' };
}

module.exports = { enrichProspectWithProxycurl };