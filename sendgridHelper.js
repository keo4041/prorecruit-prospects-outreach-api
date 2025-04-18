// Paste your existing sendEmail function here
// Ensure it requires @sendgrid/mail and logger if necessary
// Example:
const sgMail = require("@sendgrid/mail");
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
async function sendEmail(
  toEmail,
  templateId,
  templateData,
  options = {},
  logger
) {
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
  const defaultFromEmail =
    process.env.SENDGRID_FROM_EMAIL || "keo@keobrand.com";

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
      group_id: parseInt(
        process.env.SENDGRID_MARKETING_UNSUB_GROUP_ID || "24255",
        10
      ), // Use env var
      groups_to_display: parseInt(
        process.env.SENDGRID_MARKETING_UNSUB_GROUP_ID,
        10
      ) || [24255, 27845], // Use the same group ID
    },
    dynamicTemplateData: templateData,
    // Conditionally add optional parameters
    ...(options.categories && { categories: options.categories }),
    ...(options.trackingSettings && {
      trackingSettings: options.trackingSettings,
    }),
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
      logger.info(
        `Email sent successfully to ${toEmail} using template ${templateId}. Status: ${response[0].statusCode}`
      );
    } catch (error) {
      logger.error(
        `Error sending email to ${toEmail} using template ${templateId}:`,
        error.message
      );
      if (error.response) {
        logger.error("SendGrid Response Status:", error.response.statusCode);
        logger.error("SendGrid Response Body:", error.response.body); // Contains detailed errors

        const statusCode = error.response.statusCode;

        if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
          logger.error(
            `Permanent SendGrid error (${statusCode}). Not retrying.`
          );
          throw error; // Don't retry on bad request/auth issues
        } else if (statusCode === 429 || statusCode >= 500) {
          // Rate Limiting or Server Error
          retryCount++;
          if (retryCount > maxRetries) {
            logger.error(
              `Max retries (${maxRetries}) exceeded for SendGrid error (${statusCode}). Giving up for ${toEmail}.`
            );
            throw error; // Give up after max retries
          }
          const delay =
            retryDelayBase * Math.pow(2, retryCount - 1) + Math.random() * 1000; // Add jitter
          logger.warn(
            `SendGrid error (${statusCode}). Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(
              delay / 1000
            )}s for ${toEmail}`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          return sendWithRetry(); // Retry
        } else {
          logger.warn(
            `Unknown SendGrid error code (${statusCode}). Not retrying.`
          );
          throw error; // Don't retry unknown errors by default
        }
      } else {
        // Network errors or other issues (no response object)
        retryCount++;
        if (retryCount > maxRetries) {
          logger.error(
            `Max retries (${maxRetries}) exceeded for network/unknown error. Giving up for ${toEmail}.`
          );
          throw error; // Give up
        }
        const delay =
          retryDelayBase * Math.pow(2, retryCount - 1) + Math.random() * 1000;
        logger.warn(
          `Network or other error sending email. Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(
            delay / 1000
          )}s for ${toEmail}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return sendWithRetry(); // Retry network errors
      }
    }
  }

  return sendWithRetry(); // Start the send process
}

/**
 * Helper function for basic text-to-HTML conversion.
 * Replaces newlines with <br> and wraps in <p> tags.
 * Escapes basic HTML characters to prevent rendering issues if the body contains them.
 * @param {string} text - Plain text body.
 * @returns {string} Basic HTML representation.
 */
function convertTextToHtml(text) {
  if (!text) return "";
  // Basic conversion: escape HTML characters and replace newlines
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;"); // Escape apostrophe
  html = html.replace(/\r\n|\r|\n/g, "<br />\n"); // Replace newlines with <br>
  return `<p style="font-family: sans-serif; font-size: 14px; color: #333;">${html}</p>`; // Wrap in paragraph tags with basic styling
}

/**
 * Sends an email using SendGrid with raw subject and body content.
 * Assumes sgMail is initialized via setApiKey.
 *
 * @param {string} to - Recipient email address.
 * @param {string} subject - Raw email subject line.
 * @param {string} body - Raw email body content (plain text).
 * @param {object} options - SendGrid options object (containing trackingSettings, customArgs, categories, etc.).
 * @param {object} logger - Logger instance (e.g., from firebase-functions).
 * @throws {Error} Throws an error if sending fails or configuration is missing.
 */
async function sendRawEmail(to, subject, body, options, logger) {
  // --- Pre-flight Checks ---
  if (!process.env.SENDGRID_API_KEY_PATH) {
    logger.error(
      `Cannot send raw email to ${to}: SENDGRID_API_KEY environment variable not set.`
    );
    throw new Error("SendGrid API Key not configured.");
  }
  if (!process.env.SENDGRID_FROM_EMAIL) {
    logger.error(
      `Cannot send raw email to ${to}: SENDGRID_FROM_EMAIL environment variable not set.`
    );
    throw new Error("SendGrid From Email not configured.");
  }
  if (!to || !subject || !body) {
    logger.error(
      `Cannot send raw email: Missing required parameter (to, subject, or body). To: ${to}, Subject: ${subject}, Body provided: ${!!body}`
    );
    throw new Error("Missing required parameters for sendRawEmail.");
  }

  //retry in 1 min for up to 5 times
  let retryCount = 0;
  const maxRetries = 5;
  const retryDelay = 60000; // 1 minute in milliseconds

  async function sendWithRetry() {
    // --- Construct SendGrid Message Object ---
    const msg = {
      to: to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL || "keo@keobrand.com",
        name: process.env.SENDGRID_FROM_NAME || "Kwami", // Use configured name or default
      },
      subject: subject,
      text: body, // Plain text version of the body
      html: convertTextToHtml(body), // Basic HTML version of the body
      ...options, // Spread in tracking settings, categories, custom args etc.
    };

    // Ensure template-specific keys are not present if passed in options by mistake
    delete msg.templateId;
    delete msg.dynamicTemplateData;
    delete msg.asm; // If using subscription tracking options, manage it carefully or use SendGrid groups

    logger.debug(
      `Constructed raw email payload for SendGrid. To: ${to}, Subject: ${subject.substring(
        0,
        50
      )}...`
    );

    // --- Send Email ---
    try {
      // The SendGrid v3 library's send method returns an array on success
      const response = await sgMail.send(msg);
      // Log success with SendGrid's response status code (usually 202 Accepted)
      logger.info(
        `Raw email sent successfully to ${to}. Subject: "${subject}". SendGrid Response Status: ${response[0]?.statusCode}`
      );
      // You can return the response if needed by the caller
      // return response;
    } catch (error) {
      // Log detailed error information from SendGrid if available
      const errorMessage = error.response
        ? JSON.stringify(error.response.body)
        : error.message;
      logger.error(
        `SendGrid Error sending raw email to ${to}. Subject: "${subject}". Error: ${errorMessage}`,
        {
          // Log full error object if helpful
          sendGridErrorCode: error.code,
          sendGridErrorMessage: error.message,
          sendGridResponseHeaders: error.response?.headers,
        }
      );
      if (error.response) {
        const statusCode = error.response.statusCode;
        if (
          statusCode === 400 /* || statusCode === 401 */ ||
          statusCode === 403
        ) {
          logger.error(
            `Permanent SendGrid error (${statusCode}). Not retrying.`
          );
          throw error; // Don't retry on bad request/auth issues
        } else if (
          statusCode === 429 ||
          statusCode >= 401 ||
          statusCode >= 500
        ) {
          // Rate Limiting or Server Error
          retryCount++;
          if (retryCount > maxRetries) {
            logger.error(
              `Max retries (${maxRetries}) exceeded for SendGrid error (${statusCode}). Giving up for ${to}.`
            );
            throw error; // Give up after max retries
          }
          logger.warn(
            `SendGrid error (${statusCode}). Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(
              retryDelay / 1000
            )}s for ${to}`
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          return sendWithRetry(); // Retry
        } else {
          logger.warn(
            `Unknown SendGrid error code (${statusCode}). Not retrying.`
          );
          throw error; // Don't retry unknown errors by default
        }
      } else {
        // Network errors or other issues (no response object)
        retryCount++;
        if (retryCount > maxRetries) {
          logger.error(
            `Max retries (${maxRetries}) exceeded for network/unknown error. Giving up for ${to}.`
          );
          throw error; // Give up
        }
        logger.warn(
          `Network or other error sending email. Retrying attempt ${retryCount}/${maxRetries} after ${Math.round(
            retryDelay / 1000
          )}s for ${to}`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        return sendWithRetry(); // Retry network errors
      }

      // Re-throw the error so the calling function (e.g., handleInitialEmails)
      // knows the send failed and can update Firestore status accordingly.
    }
  }
  return sendWithRetry(); // Start the send process
}

module.exports = { sendEmail, sendRawEmail };
