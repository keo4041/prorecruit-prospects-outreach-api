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
    logger.info(`Enriching profile for: ${linkedinUrl} - 1`);
    const updateData = {};
    let personData = null;
    let workEmailData = null;
    let success = true;
    let finalEmailStatus = EMAIL_STATUS.FAILED; // Default to failed
    logger.info(`Before try catch: ${linkedinUrl}`);

    try {
        // --- 1. Get Person Profile ---
        logger.info(`PERSON_PROFILE_URL: ${PERSON_PROFILE_URL} - axios start`);
        const personProfileParams = { url: linkedinUrl, 
            linkedin_profile_url: linkedinUrl, 
            extra: 'include',
            fallback_to_cache: 'on-error', };
            // use fetch to get PERSON_PROFILE_URL with the params
            const personResponse = fetch(PERSON_PROFILE_URL, {
                method: 'GET',
                headers: PROXYCURL_HEADERS,
                body: JSON.stringify(personProfileParams),
                timeout: 30000, // 30 second timeout
            });
            


        /* const personResponse = await axios.get(PERSON_PROFILE_URL, {
            headers: PROXYCURL_HEADERS,
            params: personProfileParams,
            timeout: 30000, // 30 second timeout
        }); */
        logger.info(`Enriching profile for: ${linkedinUrl} - axios done`);
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
        updateData.fullName = personData.full_name || prospectData.fullName || "";
        updateData.occupation = personData.occupation || prospectData.occupation || "";
        updateData.jobTitle = personData.occupation || prospectData.jobTitle || "";
        updateData.industry = personData.industry || prospectData.industry || "";
        updateData.country = personData.country_full_name || prospectData.country || "";
        updateData.city = personData.city || prospectData.city || "";
        updateData.linkedinUrl = linkedinUrl;
        updateData.enrichmentSuccess = true; // Mark as successful
        updateData.companyName = personData.current_company?.name || personData.company || prospectData.company || ""; // Check current_company first
        updateData.location = personData.city && personData.country_full_name ? `${personData.city}, ${personData.country_full_name}` : personData.location || prospectData.location || "";
        // add the remaining properties from prospectData to updateData
        updateData.numberOfEmployees = personData.current_company?.employee_count || prospectData.numberOfEmployees || "";
        updateData.companyWebsite = personData.current_company?.website || prospectData.companyWebsite || "";
        updateData.companyLinkedinUrl = personData.current_company?.linkedin_url || prospectData.companyLinkedinUrl || "";
        updateData.companyIndustry = personData.current_company?.industry || prospectData.companyIndustry || "";
        updateData.companyDescription = personData.current_company?.description || prospectData.companyDescription || "";
        updateData.companyCity = personData.current_company?.city || prospectData.companyCity || "";
        updateData.companyCountry = personData.current_company?.country_full_name || prospectData.companyCountry || "";
        updateData.companyLocation = personData.current_company?.city && personData.current_company?.country_full_name ? `${personData.current_company.city}, ${personData.current_company.country_full_name}` : prospectData.companyLocation || "";
        updateData.enrichmentTimestamp = admin.firestore.Timestamp.now();
        updateData.linkedinUrlFound = true;
        updateData.linkedinProfileUrl = linkedinUrl;
        updateData.groups = personData.groups || [];
        updateData.articles = personData.articles || [];
        updateData.skills = personData.skills || [];
        updateData.languages = personData.languages || [];
        updateData.interests = personData.interests || [];
        updateData.educations = personData.educations || [];
        updateData.experiences = personData.experiences || [];
        updateData.headline = personData.headline || "";
        updateData.summary = personData.summary || "";  
        updateData.accomplishment_publications = personData.accomplishment_publications || [];
        updateData.accomplishment_projects = personData.accomplishment_projects || [];
        updateData.accomplishment_certifications = personData.accomplishment_certifications || [];
        updateData.accomplishment_awards = personData.accomplishment_awards || [];
        updateData.accomplishment_honors = personData.accomplishment_honors || [];
        updateData.accomplishment_courses = personData.accomplishment_courses || [];
        updateData.accomplishment_organisations = personData.accomplishment_organisations || [];
        updateData.accomplishment_events = personData.accomplishment_events || [];
        updateData.accomplishment_jobs = personData.accomplishment_jobs || [];
        updateData.accomplishment_skills = personData.accomplishment_skills || [];
        updateData.accomplishment_languages = personData.accomplishment_languages || [];
        updateData.accomplishment_interests = personData.accomplishment_interests || [];
        updateData.accomplishment_educations = personData.accomplishment_educations || [];
        updateData.accomplishment_experiences = personData.accomplishment_experiences || [];
        updateData.volunteer_work = personData.volunteer_work || [];
        updateData.birth_date = personData.birth_date || "";
        updateData.personal_emails = personData.personal_emails || "";
        updateData.personal_numbers = personData.personal_numbers || "";
        updateData.personal_websites = personData.personal_websites || "";
        updateData.personal_urls = personData.personal_urls || "";
        updateData.personal_addresses = personData.personal_addresses || "";
        updateData.gender = personData.gender || "";
        updateData.interests = personData.interests || [];
        updateData.extra = personData.extra || [];

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
    logger.info(`end of try catch for ${linkedinUrl} - ${finalEmailStatus} - ${success} - ${updateData}`)

    updateData.enrichmentTimestamp = admin.firestore.Timestamp.now(); // Always update timestamp

    return { success, updateData, error: success ? null : 'Proxycurl API Error' };
}

module.exports = { enrichProspectWithProxycurl };