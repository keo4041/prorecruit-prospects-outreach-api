// Paste your existing sendEmail function here
// Ensure it requires @sendgrid/mail and logger if necessary
// Example:
const sgMail = require('@sendgrid/mail');
// Assume logger is passed in or globally available

/**
 * Sends a transactional email using SendGrid,
 * handling retries and optional parameters.
 *
 * @param {string} toEmail The recipient's email address.
 * @param {string} templateId The SendGrid template ID.
 * @param {object} templateData The data to be used in the template.
 * @param {object} [options] Optional SendGrid parameters (categories, trackingSettings, customArgs).
 * @param {object} logger - Logger instance.
 * @return {Promise<void>}
 */
async function sendEmail(toEmail, templateId, templateData, options = {}, logger) {
    logger.info(`Sending email to ${toEmail} using template ${templateId}`);
    if (!process.env.SENDGRID_API_KEY_PATH) {
        logger.error("SENDGRID_API_KEY not set. Cannot send email.");
        throw new Error("SENDGRID_API_KEY not set.");
    }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY_PATH);

    logger.info(`Preparing email to ${toEmail} using template ${templateId}`);
    // console.log("Template Data:", templateData); // Sensitive data, maybe log less
    // console.log("Options:", options);

    const defaultFromName = process.env.SENDGRID_FROM_NAME || "Kwami";
    const defaultFromEmail = process.env.SENDGRID_FROM_EMAIL || "keo@keobrand.com";

    if (!defaultFromEmail) {
         logger.error("Default FROM email not configured.");
         throw new Error("Default FROM email not configured.");
    }


    const msg = {
        to: toEmail,
        from: {
            email: templateData.from || defaultFromEmail,
            name: templateData.fromName || defaultFromName,
        },
        templateId: templateId,
        // Standard SendGrid Unsubscribe Group (replace with your actual group ID)
        asm: {
            group_id: parseInt(process.env.SENDGRID_MARKETING_UNSUB_GROUP_ID || "24255", 10), // Use env var
            groups_to_display: parseInt(process.env.SENDGRID_MARKETING_UNSUB_GROUP_ID, 10) || [24255, 27845], // Use the same group ID
        },
        dynamicTemplateData: templateData,
        // Conditionally add optional parameters
        ...(options.categories && { categories: options.categories }),
        ...(options.trackingSettings && { trackingSettings: options.trackingSettings }),
        ...(options.customArgs && { customArgs: options.customArgs }),
    };

    // Retry configuration (adjust as needed)
    const maxRetries = 3; // Reduced retries for scheduled tasks
    const retryDelayBase = 5000;
    let retryCount = 0;

    // eslint-disable-next-line require-jsdoc
    async function sendWithRetry() {
        try {
            const response = await sgMail.send(msg);
            logger.info(`Email sent successfully to ${toEmail} using template ${templateId}. Status: ${response[0].statusCode}`);
        } catch (error) {
            logger.error(`Error sending email to ${toEmail} using template ${templateId}:`, error.message);
            if (error.response) {
                logger.error("SendGrid Response Status:", error.response.statusCode);
                logger.error("SendGrid Response Body:", error.response.body); // Contains detailed errors

                const statusCode = error.response.statusCode;

                if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
                    logger.error(`Permanent SendGrid error (${statusCode}). Not retrying.`);
                    throw error; // Don't retry on bad request/auth issues
                } else if (statusCode === 429 || statusCode >= 500) {
                    // Rate Limiting or Server Error
                    retryCount++;
                    if (retryCount > maxRetries) {
                        logger.error(`Max retries (${maxRetries}) exceeded for SendGrid error (${statusCode}). Giving up for ${toEmail}.`);
                        throw error; // Give up after max retries
                    }
                    const delay = retryDelayBase * Math.pow(2, retryCount - 1) + Math.random() * 1000; // Add jitter
                    logger.warn(`SendGrid error (${statusCode}). Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(delay / 1000)}s for ${toEmail}`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    return sendWithRetry(); // Retry
                } else {
                    logger.warn(`Unknown SendGrid error code (${statusCode}). Not retrying.`);
                    throw error; // Don't retry unknown errors by default
                }
            } else {
                // Network errors or other issues (no response object)
                retryCount++;
                if (retryCount > maxRetries) {
                    logger.error(`Max retries (${maxRetries}) exceeded for network/unknown error. Giving up for ${toEmail}.`);
                    throw error; // Give up
                }
                const delay = retryDelayBase * Math.pow(2, retryCount - 1) + Math.random() * 1000;
                logger.warn(`Network or other error sending email. Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(delay / 1000)}s for ${toEmail}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
                return sendWithRetry(); // Retry network errors
            }
        }
    }

    return sendWithRetry(); // Start the send process
}

module.exports = { sendEmail };