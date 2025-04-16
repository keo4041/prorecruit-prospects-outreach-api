const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
const {logger} = require("firebase-functions");
const { enrichProspectWithProxycurl } = require('./proxycurlHelper');
const { updateProspect } = require('./firestoreHelper');
const { sendEmail } = require('./sendgridHelper');
const {
    MAX_PROSPECTS_TO_ENRICH_PER_RUN,
    MAX_INITIAL_EMAILS_PER_RUN,
    MAX_FOLLOWUP_EMAILS_PER_RUN,
    EMAIL_STATUS,
    OUTREACH_STATUS,
    getFollowupDueDate,
    determineTemplateId,
} = require('./config');

// --- Initialization ---
let db;
let isInitialized = false;

function initialize() {
    logger.info('Initializing...');                                 
    if (isInitialized) return;
    try {
        admin.initializeApp();
        db = admin.firestore();

        
        logger.info('Initialization complete.');
        isInitialized = true;
    } catch (error) {
        console.error("FATAL: Initialization failed", error);
        // If logger failed, use console
        (logger || console).error("Initialization failed", error);
        // Prevent function execution if init fails badly
        throw new Error("Initialization failed, cannot proceed.");
    }

}

// --- Helper Functions ---

/**
 * Prepares SendGrid options including tracking and custom args.
 * @param {object} prospectData - Prospect data from Firestore.
 * @param {string} emailType - 'initial' or 'followup'.
 */
function prepareSendgridOptions(prospectData, emailType) {
     // Determine campaign based on type, language, country maybe?
    const campaignBase = `prospect_outreach_${emailType}`;
    const utmCampaign = `${campaignBase}_${prospectData.language || 'na'}_${prospectData.country || 'na'}`;
    const utmTerm = `${emailType}-${prospectData.segment || 'default'}`; // Example term

    return {
        categories: [
            "Marketing", // General category
            `Outreach-${emailType}`, // e.g., Outreach-initial
            `Outreach-${prospectData.language || 'na'}`, // e.g., Outreach-en
            `Outreach-${prospectData.country || 'na'}`, // e.g., Outreach-US
        ],
        trackingSettings: {
            clickTracking: { enable: true, enableText: false }, // Don't rewrite text links usually
            openTracking: { enable: true },
            subscriptionTracking: { enable: false }, // Use ASM group instead
            ganalytics: {
                enable: true,
                utmSource: "sendgrid",
                utmMedium: "email",
                utmCampaign: utmCampaign,
                utmTerm: utmTerm,
                utmContent: `template-${determineTemplateId(prospectData, emailType) || 'unknown'}`, // Track template used
            },
        },
        customArgs: { // For tracking in SendGrid stats / webhooks
            prospectId: prospectData.id, // Firestore Doc ID
            email: prospectData.workEmail || prospectData.email, // Email sent to
            language: prospectData.language || "",
            country: prospectData.country || "",
            segment: prospectData.segment || "",
            outreachStatusBeforeSend: prospectData.outreachStatus,
            emailType: emailType,
            // Add other relevant non-sensitive tracking data
            company: prospectData.company || "",
            jobTitle: prospectData.jobTitle || "",
        },
    };
}

/**
 * Prepares the dynamic data object for the SendGrid template.
 * @param {object} prospectData - Prospect data from Firestore.
 */
function prepareTemplateData(prospectData) {
    const unsubscribeUrl = process.env.UNSUBSCRIBE_URL || `https://app.prorecruit.tech/support`; // Fallback needed
    if (!unsubscribeUrl) {
        logger.warn(`UNSUBSCRIBE_URL not set for prospect ${prospectData.id}`);
        // Decide if you should proceed without it - likely NOT for compliance.
        // throw new Error("Unsubscribe URL is missing.");
    }
    return {
        firstName: prospectData.firstName || "", // Use enriched data preferentially
        lastName: prospectData.lastName || "",
        companyName: prospectData.companyName || prospectData.company || "", // Use enriched companyName first
        jobTitle: prospectData.jobTitle || "", // Use enriched jobTitle
        // Add other fields used in your templates:
        // companySize: prospectData.numberOfEmployees || "N/A", // Assuming you have this field mapped
        // industry: prospectData.industry || "N/A",
        companyCountry: prospectData.country || "N/A",
        companyCity: prospectData.city || "N/A",
        unsubscribeUrl: unsubscribeUrl, // CRITICAL for compliance
        // You might need specific fields for different templates
    };
}


// --- Main Processing Logic ---

/**
 * Process prospects needing enrichment.
 */
async function handleEnrichment() {
    logger.info(`Starting enrichment process. Max prospects: ${MAX_PROSPECTS_TO_ENRICH_PER_RUN}`);
    let processedCount = 0;
    let successCount = 0;

    try {
        const prospectsToEnrichQuery = db.collection('prospects')
            .where('enrichmentTimestamp', '==', null) // Primary condition
            .where('outreachStatus', '!=', OUTREACH_STATUS.DO_NOT_CONTACT) // Optional: Avoid enriching DNC
            .limit(MAX_PROSPECTS_TO_ENRICH_PER_RUN);

        const snapshot = await prospectsToEnrichQuery.get();

        if (snapshot.empty) {
            logger.info('No prospects found needing enrichment.');
            return { processed: 0, successful: 0 };
        }

        logger.info(`Found ${snapshot.size} prospects to enrich.`);

        // Process sequentially to respect rate limits and simplify error handling
        for (const doc of snapshot.docs) {
            const prospectId = doc.id;
            const prospectData = { id: prospectId, ...doc.data() }; // Include ID in data
            processedCount++;

            // Optional: Add a temporary 'processing' status if needed
            // await updateProspect(prospectId, { emailStatus: EMAIL_STATUS.PROCESSING }, db, logger);

            const enrichmentResult = await enrichProspectWithProxycurl(prospectData, logger);

            if (enrichmentResult.success) {
                successCount++;
                 // Merge enrichment data with potential status update
                await updateProspect(prospectId, enrichmentResult.updateData, db, logger);
            } else {
                logger.error(`Enrichment failed for prospect ${prospectId}: ${enrichmentResult.error}`);
                 // Update with failure status and timestamp
                 await updateProspect(prospectId, enrichmentResult.updateData, db, logger); // updateData contains failure status
            }
             // Optional: Small delay between ProxyCurl calls if hitting rate limits
             // await new Promise(resolve => setTimeout(resolve, 500));
        }

    } catch (error) {
        logger.error('Error during enrichment phase:', error);
        // Don't let enrichment errors stop email sending if possible
    }
    logger.info(`Enrichment phase complete. Processed: ${processedCount}, Successful: ${successCount}`);
    return { processed: processedCount, successful: successCount };
}

/**
 * Process prospects ready for their initial outreach email.
 */
async function handleInitialEmails() {
    logger.info(`Starting initial email sending process. Max emails: ${MAX_INITIAL_EMAILS_PER_RUN}`);
    let sentCount = 0;
    let errorCount = 0;

    try {
        const prospectsToSendQuery = db.collection('prospects')
            .where('emailStatus', '==', EMAIL_STATUS.VERIFIED)
            .where('outreachStatus', '==', OUTREACH_STATUS.PENDING_UPLOAD)
            .limit(MAX_INITIAL_EMAILS_PER_RUN);

        const snapshot = await prospectsToSendQuery.get();

        if (snapshot.empty) {
            logger.info('No prospects found for initial email.');
            return { sent: 0, errors: 0 };
        }

        logger.info(`Found ${snapshot.size} prospects for initial email.`);

        // Process sequentially
        for (const doc of snapshot.docs) {
            const prospectId = doc.id;
            const prospectData = { id: prospectId, ...doc.data() };
            const recipientEmail = prospectData.workEmail || prospectData.email; // Prefer verified work email

            if (!recipientEmail) {
                logger.warn(`Prospect ${prospectId} has verified status but no email address. Skipping.`);
                await updateProspect(prospectId, { outreachStatus: OUTREACH_STATUS.ENRICHMENT_FAILED }, db, logger); // Mark as failed
                errorCount++;
                continue;
            }

            const templateId = determineTemplateId(prospectData, 'initial');
            if (!templateId) {
                logger.warn(`Could not determine initial template ID for prospect ${prospectId} (Lang: ${prospectData.language}, Country: ${prospectData.country}). Skipping.`);
                 await updateProspect(prospectId, { outreachStatus: 'template_missing' }, db, logger); // Custom status
                errorCount++;
                continue;
            }

            const templateData = prepareTemplateData(prospectData);
            const options = prepareSendgridOptions(prospectData, 'initial');

            try {
                await sendEmail(recipientEmail, templateId, templateData, options, logger);
                // Update status AFTER successful send
                await updateProspect(prospectId, {
                    outreachStatus: OUTREACH_STATUS.SEQUENCE_STARTED,
                    lastContactedTimestamp: admin.firestore.Timestamp.now(),
                }, db, logger);
                sentCount++;
                // Optional delay
                // await new Promise(resolve => setTimeout(resolve, 200));
            } catch (emailError) {
                logger.error(`Failed to send initial email to ${prospectId} (${recipientEmail}):`, emailError.message);
                // Optionally update status to something like 'send_failed' ?
                // await updateProspect(prospectId, { outreachStatus: 'initial_send_failed' }, db, logger);
                errorCount++;
                // Continue to next prospect even if one fails
            }
        }

    } catch (error) {
        logger.error('Error during initial email phase:', error);
    }
    logger.info(`Initial email phase complete. Sent: ${sentCount}, Errors: ${errorCount}`);
    return { sent: sentCount, errors: errorCount };
}

/**
 * Process prospects ready for follow-up emails.
 */
async function handleFollowupEmails() {
    logger.info(`Starting follow-up email sending process. Max emails: ${MAX_FOLLOWUP_EMAILS_PER_RUN}`);
    let sentCount = 0;
    let errorCount = 0;
    let candidatesChecked = 0;

    // Statuses eligible for follow-up
    const followupEligibleStatuses = Object.keys(FOLLOWUP_INTERVALS_DAYS);

    if (followupEligibleStatuses.length === 0) {
        logger.info("No follow-up intervals configured. Skipping follow-up phase.");
        return { sent: 0, errors: 0 };
    }

    try {
        // Query for prospects in any state that *could* receive a follow-up
        const prospectsToCheckQuery = db.collection('prospects')
            .where('outreachStatus', 'in', followupEligibleStatuses)
            // Optional: Add safety limit if list is huge, but filtering is done in code
            .limit(MAX_FOLLOWUP_EMAILS_PER_RUN * 5) // Fetch more candidates than needed
            ;

        const snapshot = await prospectsToCheckQuery.get();
        candidatesChecked = snapshot.size;

        if (snapshot.empty) {
            logger.info('No prospects found in eligible follow-up statuses.');
            return { sent: 0, errors: 0 };
        }

        logger.info(`Found ${snapshot.size} candidates to check for follow-up.`);

        const now = admin.firestore.Timestamp.now();
        let emailsSentThisRun = 0;

        // Process sequentially, checking dates in code
        for (const doc of snapshot.docs) {
            if (emailsSentThisRun >= MAX_FOLLOWUP_EMAILS_PER_RUN) {
                logger.info(`Reached follow-up email limit (${MAX_FOLLOWUP_EMAILS_PER_RUN}). Stopping follow-up sends for this run.`);
                break;
            }

            const prospectId = doc.id;
            const prospectData = { id: prospectId, ...doc.data() };
            const currentStatus = prospectData.outreachStatus;

            // Calculate when the follow-up is due
            const dueDate = getFollowupDueDate(prospectData.lastContactedTimestamp, currentStatus);

            // Check if due date is valid and in the past (or now)
            if (dueDate && dueDate <= now) {
                 logger.info(`Prospect ${prospectId} is due for follow-up (Status: ${currentStatus}, Due: ${dueDate.toDate().toISOString()})`);

                 const recipientEmail = prospectData.workEmail || prospectData.email;
                 if (!recipientEmail) {
                    logger.warn(`Prospect ${prospectId} due for follow-up has no email. Skipping.`);
                    // Consider updating status to an error state?
                    errorCount++;
                    continue;
                 }

                 // Determine the *next* status (e.g., if current is 'sequence_started', next is 'followup_1')
                 let nextStatus = null;
                 if (currentStatus === OUTREACH_STATUS.SEQUENCE_STARTED) {
                     nextStatus = OUTREACH_STATUS.FOLLOWUP_1;
                 } else if (currentStatus === OUTREACH_STATUS.FOLLOWUP_1) {
                     nextStatus = OUTREACH_STATUS.FOLLOWUP_2;
                 } // Add more else if clauses for further followups

                 if (!nextStatus) {
                    logger.warn(`Prospect ${prospectId} is in status ${currentStatus}, but no next follow-up status is defined. Skipping.`);
                    errorCount++;
                    continue;
                 }

                 const templateId = determineTemplateId(prospectData, 'followup'); // Use 'followup' type
                 if (!templateId) {
                    logger.warn(`Could not determine follow-up template ID for prospect ${prospectId} (Lang: ${prospectData.language}, Country: ${prospectData.country}). Skipping.`);
                    await updateProspect(prospectId, { outreachStatus: 'template_missing_followup' }, db, logger);
                    errorCount++;
                    continue;
                 }

                 const templateData = prepareTemplateData(prospectData);
                 const options = prepareSendgridOptions(prospectData, 'followup');

                 try {
                    await sendEmail(recipientEmail, templateId, templateData, options, logger);
                    // Update status AFTER successful send
                    await updateProspect(prospectId, {
                        outreachStatus: nextStatus, // Move to next stage
                        lastContactedTimestamp: admin.firestore.Timestamp.now(),
                    }, db, logger);
                    sentCount++;
                    emailsSentThisRun++;
                    // Optional delay
                    // await new Promise(resolve => setTimeout(resolve, 200));
                 } catch (emailError) {
                    logger.error(`Failed to send follow-up email to ${prospectId} (${recipientEmail}):`, emailError.message);
                    // Optionally update status to something like 'followup_send_failed' ?
                    errorCount++;
                    // Continue to next prospect
                 }

            } // end if(dueDate && dueDate <= now)
        } // end for loop

    } catch (error) {
        logger.error('Error during follow-up email phase:', error);
    }
    logger.info(`Follow-up email phase complete. Candidates checked: ${candidatesChecked}, Sent: ${sentCount}, Errors: ${errorCount}`);
    return { sent: sentCount, errors: errorCount };
}


// --- Cloud Function Entry Point ---
functions.http('processProspects', async (req, res) => {
    // Initialize on first invocation (or cold start)
    console.log("Initializing... - console", req.get('User-Agent'));
    logger.info('Initializing... - logger', req.get('User-Agent'));
    try {
        initialize();
    } catch (initError) {
        console.error("Initialization failed in entry point:", initError);
        res.status(500).send('Internal Server Error: Initialization Failed');
        return; // Stop execution
    }

    logger.info('Received request to process prospects.', req.get('User-Agent'));

    // Optional: Add security check (e.g., verify request comes from Cloud Scheduler)
    /* const isScheduler = req.get('User-Agent') === 'Google-Cloud-Scheduler';
    if (!isScheduler && process.env.NODE_ENV === 'production') {
       logger.warn('Request rejected: Not from Cloud Scheduler.');
       res.status(403).send('Forbidden');
       return;
    } */

    try {
        // --- Phase 1: Enrichment ---
        const enrichmentStats = await handleEnrichment();

        // --- Phase 2: Initial Emails ---
        const initialEmailStats = await handleInitialEmails();

        // --- Phase 3: Follow-up Emails ---
        const followupEmailStats = await handleFollowupEmails();

        logger.info('Prospect processing finished successfully.');
        res.status(200).send(`OK. Enriched: ${enrichmentStats.successful}/${enrichmentStats.processed}. Initial Sent: ${initialEmailStats.sent} (Errors: ${initialEmailStats.errors}). Follow-up Sent: ${followupEmailStats.sent} (Errors: ${followupEmailStats.errors}).`);

    } catch (error) {
        logger.error('Unhandled error in processProspects function:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Export for Functions Framework (if not using HTTP)
// exports.processProspects = processProspects; // Example for background function