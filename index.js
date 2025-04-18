const functions = require("@google-cloud/functions-framework");
const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { enrichProspectWithProxycurl } = require("./proxycurlHelper");
const { updateProspect } = require("./firestoreHelper");
const { sendEmail } = require("./sendgridHelper");
const { VertexAI } = require("@google-cloud/vertexai"); // Import Vertex AI SDK
const {
  MAX_PROSPECTS_TO_ENRICH_PER_RUN,
  MAX_INITIAL_EMAILS_PER_RUN,
  MAX_FOLLOWUP_EMAILS_PER_RUN,
  MAX_AI_EMAILS_PER_RUN,
  FOLLOWUP_INTERVALS_DAYS,
  EMAIL_STATUS,
  OUTREACH_STATUS,
  getFollowupDueDate,
  determineTemplateId,
} = require("./config");

// --- Initialization ---
let db;
let isInitialized = false;
let vertexai; // Variable to hold Vertex AI client

// --- Vertex AI Schema Definition (as defined above) ---
const vertexAiOutputSchema = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "The generated, personalized email subject line, concise and benefit-oriented.",
    },
    body: {
      type: "string",
      description:
        'The generated, personalized email body text following cultural etiquette and cold email best practices, addressing pain points with ProRecruit.tech solutions, and including a low-friction call to action. Do not include greetings (like "Hi [Name],") or sign-offs (like "Best regards,"), only the core body content.', // Be specific about excluding greetings/signoffs if you add them later
    },
  },
  required: ["subject", "body"],
};
const aiEmailGeneratorFunctionDeclaration = {
  name: "generate_prospect_email", // Function name Vertex AI will "call"
  description:
    "Generates a personalized cold outreach email subject and body for a prospect.",
  parameters: vertexAiOutputSchema,
};

function initialize() {
  logger.info("Initializing...");
  if (isInitialized) return;
  try {
    admin.initializeApp();
    db = admin.firestore();

    // Initialize Vertex AI Client
    const projectId = process.env.GCP_PROJECT || "interview-412415"; // Automatically available in Cloud Functions
    const location = process.env.GCP_REGION || "us-central1"; // Set via env var or default
    if (!projectId || !location) {
      throw new Error(`GCLOUD_PROJECT or GCP_REGION environment variable not set. projectId: ${projectId}, location: ${location}`);
    }
    vertexai = new VertexAI({ project: projectId, location: location });
    logger.info(
      `Vertex AI Client Initialized for project: ${projectId}, location: ${location}`
    );

    logger.info("Initialization complete.");
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
 * @param {object|null} aiEmailData - Optional AI generated subject/body.
 */
function prepareSendgridOptions(prospectData, emailType, aiEmailData = null) {
  // Determine campaign based on type, language, country maybe?
  const campaignBase = `prospect_outreach_${emailType}`;
  const utmCampaign = `${campaignBase}_${prospectData.language || "na"}_${
    prospectData.country || "na"
  }`;
  const utmTerm = `${emailType}-${prospectData.segment || "default"}`; // Example term
    // Use AI subject for utmContent if available, otherwise fallback to template ID
    const utmContentBase = aiEmailData?.subject
        ? `ai-${aiEmailData.subject.substring(0, 30).replace(/ /g,'_')}` // Shortened/slugified AI subject
        : `template-${determineTemplateId(prospectData, emailType) || 'unknown'}`;

  return {
    categories: [
      "Marketing", // General category
      `Outreach-${emailType}`, // e.g., Outreach-initial
      `Outreach-${prospectData.language || "na"}`, // e.g., Outreach-en
      `Outreach-${prospectData.country || "na"}`, // e.g., Outreach-US
      aiEmailData ? "AI-Generated" : "Template-Based", // Mark if AI was used
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
        utmContent: utmContentBase, // Track template used
      },
    },
    customArgs: {
      // For tracking in SendGrid stats / webhooks
      prospectId: prospectData.id, // Firestore Doc ID
      email:
        prospectData.workEmail ||
        prospectData.email ||
        prospectData.personalEmail ||
        prospectData.personal_emails[0], // Email sent to
      language: prospectData.language || "",
      country: prospectData.country || "",
      segment: prospectData.segment || "",
      outreachStatusBeforeSend: prospectData.outreachStatus,
      emailType: emailType,
      usedAiGeneration: !!aiEmailData, // Track if AI was used
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
  const unsubscribeUrl =
    process.env.UNSUBSCRIBE_URL || `https://app.prorecruit.tech/support`; // Fallback needed
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
  logger.info(
    `Starting enrichment process. Max prospects: ${MAX_PROSPECTS_TO_ENRICH_PER_RUN}`
  );
  let processedCount = 0;
  let successCount = 0;

  try {
    const prospectsToEnrichQuery = db
      .collection("prospects")
      .where("enrichmentSuccess", "!=", true) // Primary condition
      .where("linkedinUrlFound", "==", true) // Primary condition
      .limit(MAX_PROSPECTS_TO_ENRICH_PER_RUN);

    const snapshot = await prospectsToEnrichQuery.get();

    if (snapshot.empty) {
      logger.info("No prospects found needing enrichment.");
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

      const enrichmentResult = await enrichProspectWithProxycurl(
        prospectData,
        logger
      );

      if (enrichmentResult.success) {
        successCount++;
        // Merge enrichment data with potential status update
        await updateProspect(
          prospectId,
          enrichmentResult.updateData,
          db,
          logger
        );
      } else {
        logger.error(
          `Enrichment failed for prospect ${prospectId}: ${enrichmentResult.error}`
        );
        // Update with failure status and timestamp
        await updateProspect(
          prospectId,
          enrichmentResult.updateData,
          db,
          logger
        ); // updateData contains failure status
      }
      // Optional: Small delay between ProxyCurl calls if hitting rate limits
      // await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    logger.error("Error during enrichment phase:", error);
    // Don't let enrichment errors stop email sending if possible
  }
  logger.info(
    `Enrichment phase complete. Processed: ${processedCount}, Successful: ${successCount}`
  );
  return { processed: processedCount, successful: successCount };
}

/**
 * Process prospects ready for their initial outreach email.
 */
async function handleInitialEmails() {
  logger.info(
    `Starting initial email sending process. Max emails: ${MAX_INITIAL_EMAILS_PER_RUN}`
  );
  let sentCount = 0;
  let errorCount = 0;

  try {
    const prospectsToSendQuery = db
      .collection("prospects")
      .where("enrichmentSuccess", "==", true)
      .where("outreachStatus", "==", OUTREACH_STATUS.PENDING_UPLOAD)
      .limit(MAX_INITIAL_EMAILS_PER_RUN);

    const snapshot = await prospectsToSendQuery.get();

    if (snapshot.empty) {
      logger.info("No prospects found for initial email.");
      return { sent: 0, errors: 0 };
    }

    logger.info(`Found ${snapshot.size} prospects for initial email.`);

    // Process sequentially
    for (const doc of snapshot.docs) {
      const prospectId = doc.id;
      const prospectData = { id: prospectId, ...doc.data() };
      const recipientEmail =
        prospectData.workEmail ||
        prospectData.email ||
        prospectData.personalEmail ||
        prospectData.personal_emails[0]; // Prefer verified work email

      if (!recipientEmail) {
        logger.warn(
          `Prospect ${prospectId} has verified status but no email address. Skipping.`
        );
        await updateProspect(
          prospectId,
          {
            outreachStatus: OUTREACH_STATUS.ENRICHMENT_FAILED,
            outreachStatusMessage: `Prospect ${prospectId} has verified status but no email address. Skipping.`,
          },
          db,
          logger
        ); // Mark as failed
        errorCount++;
        continue;
      }
      let emailSubject,
        emailBody,
        templateId = null,
        sendMethod;
      let options; // SendGrid options

      // *** NEW LOGIC ***
      if (
        prospectData.aiInitialEmailTemplate === true &&
        prospectData.aiInitialEmail
      ) {
        // Use AI Generated Content
        logger.info(`Using AI-generated content for prospect ${prospectId}`);
        // Construct the full body - add greeting/signature here if not in AI output
        const emailSubject = prospectData.aiInitialEmail.subject;
        const aiBodyContent = prospectData.aiInitialEmail.body; // The core content from AI

        // --- Language-Specific Construction ---
        const firstName = prospectData.firstName;
        const language = prospectData.language?.toLowerCase(); // Normalize to lowercase, handle potential undefined
        const unsubscribeUrl =
          process.env.UNSUBSCRIBE_URL || `https://app.prorecruit.tech/support`; // Ensure this is defined

        let greeting;
        let closing;
        let unsubscribeText;
        let fullBody; // Variable for the final constructed body

        if (language === "french" || language === "fr") {
          // Use French elements
          greeting = `Bonjour${firstName ? " " + firstName : ""},`; // "Bonjour Jean," or "Bonjour," if no first name
          closing = "Cordialement,"; // Standard formal French closing
          unsubscribeText = "Se désabonner"; // French for "Unsubscribe"

          // Construct the full body for French email
          fullBody = `${greeting}\n\n${aiBodyContent}\n\n${closing}\n[Your Name/Team]\n\n---\n${unsubscribeText}: ${unsubscribeUrl}`;
        } else {
          // Default to English if language is 'english', null, undefined, or any other value
          greeting = `Hi ${firstName || "there"},`; // "Hi Jane," or "Hi there," if no first name
          closing = "Best regards,"; // Standard professional English closing
          unsubscribeText = "Unsubscribe"; // English for "Unsubscribe"

          // Construct the full body for English email
          fullBody = `${greeting}\n\n${aiBodyContent}\n\n${closing}\n[Your Name/Team]\n\n---\n${unsubscribeText}: ${unsubscribeUrl}`;
        }
        // --- End Language-Specific Construction ---

        options = prepareSendgridOptions(
          prospectData,
          "initial",
          prospectData.aiInitialEmail
        ); // Pass AI data
        sendMethod = "content"; // Indicate sending raw content

        // VALIDATE AI CONTENT HERE - e.g., check length, presence of subject/body
        if (!emailSubject || !emailBody || emailBody.length < 50) {
          // Basic validation
          logger.error(
            `Invalid AI content for ${prospectId}. Subject: ${emailSubject}, Body Length: ${emailBody?.length}. Skipping.`
          );
          await updateProspect(
            prospectId,
            { outreachStatus: "ai_content_invalid" },
            db,
            logger
          );
          errorCount++;
          continue;
        }
      } else {
        const templateId = determineTemplateId(prospectData, "initial");
        if (!templateId) {
          logger.warn(
            `Could not determine initial template ID for prospect ${prospectId} (Lang: ${prospectData.language}, Country: ${prospectData.country}). Skipping.`
          );
          await updateProspect(
            prospectId,
            { outreachStatus: "template_missing" },
            db,
            logger
          ); // Custom status
          errorCount++;
          continue;
        }

        options = prepareSendgridOptions(prospectData, "initial");
        sendMethod = "template"; // Indicate sending via template
      }

      try {
        if (sendMethod === "content") {
          // You'll need to adjust sendEmail or add a new function
          // to handle sending raw subject/body instead of templateId
          await sendRawEmail(
            recipientEmail,
            emailSubject,
            emailBody,
            options,
            logger
          ); // New function needed
        } else {
          // sendMethod === 'template'
          const templateData = prepareTemplateData(prospectData); // Ensure templateData is defined here
          await sendEmail(
            recipientEmail,
            templateId,
            templateData,
            options,
            logger
          );
        }
        // Update status AFTER successful send
        await updateProspect(
          prospectId,
          {
            outreachStatus: OUTREACH_STATUS.SEQUENCE_STARTED,
            lastContactedTimestamp: admin.firestore.Timestamp.now(),
          },
          db,
          logger
        );
        sentCount++;
        // Optional delay
        // await new Promise(resolve => setTimeout(resolve, 200));
      } catch (emailError) {
        logger.error(
          `Failed to send initial email to ${prospectId} (${recipientEmail}):`,
          emailError.message
        );
        // Optionally update status to something like 'send_failed' ?
        // await updateProspect(prospectId, { outreachStatus: 'initial_send_failed' }, db, logger);
        errorCount++;
        // Continue to next prospect even if one fails
      }
    }
  } catch (error) {
    logger.error("Error during initial email phase:", error);
  }
  logger.info(
    `Initial email phase complete. Sent: ${sentCount}, Errors: ${errorCount}`
  );
  return { sent: sentCount, errors: errorCount };
}

/**
 * Process prospects ready for follow-up emails.
 */
async function handleFollowupEmails() {
  logger.info(
    `Starting follow-up email sending process. Max emails: ${MAX_FOLLOWUP_EMAILS_PER_RUN}`
  );
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
    const prospectsToCheckQuery = db
      .collection("prospects")
      .where("outreachStatus", "in", followupEligibleStatuses)
      .where("followupNotNeeded", "!=", true)
      // Optional: Add safety limit if list is huge, but filtering is done in code
      .limit(MAX_FOLLOWUP_EMAILS_PER_RUN * 5); // Fetch more candidates than needed
    const snapshot = await prospectsToCheckQuery.get();
    candidatesChecked = snapshot.size;

    if (snapshot.empty) {
      logger.info("No prospects found in eligible follow-up statuses.");
      return { sent: 0, errors: 0 };
    }

    logger.info(`Found ${snapshot.size} candidates to check for follow-up.`);

    const now = admin.firestore.Timestamp.now();
    let emailsSentThisRun = 0;

    // Process sequentially, checking dates in code
    for (const doc of snapshot.docs) {
      if (emailsSentThisRun >= MAX_FOLLOWUP_EMAILS_PER_RUN) {
        logger.info(
          `Reached follow-up email limit (${MAX_FOLLOWUP_EMAILS_PER_RUN}). Stopping follow-up sends for this run.`
        );
        break;
      }

      const prospectId = doc.id;
      const prospectData = { id: prospectId, ...doc.data() };
      const currentStatus = prospectData.outreachStatus;

      // Calculate when the follow-up is due
      const dueDate = getFollowupDueDate(
        prospectData.lastContactedTimestamp,
        currentStatus
      );

      // Check if due date is valid and in the past (or now)
      if (dueDate && dueDate <= now) {
        logger.info(
          `Prospect ${prospectId} is due for follow-up (Status: ${currentStatus}, Due: ${dueDate
            .toDate()
            .toISOString()})`
        );

        const recipientEmail =
          prospectData.workEmail ||
          prospectData.email ||
          prospectData.personalEmail ||
          prospectData.personal_emails[0];
        if (!recipientEmail) {
          logger.warn(
            `Prospect ${prospectId} due for follow-up has no email. Skipping.`
          );
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
        } else {
          // move prospect to leads collection
          nextStatus = OUTREACH_STATUS.MOVED_TO_LEADS;
          await updateProspect(
            prospectId,
            { outreachStatus: nextStatus },
            db,
            logger
          );
          continue;
        }

        if (!nextStatus) {
          logger.warn(
            `Prospect ${prospectId} is in status ${currentStatus}, but no next follow-up status is defined. Skipping.`
          );
          errorCount++;
          continue;
        }

        const templateId = determineTemplateId(prospectData, "followup"); // Use 'followup' type
        if (!templateId) {
          logger.warn(
            `Could not determine follow-up template ID for prospect ${prospectId} (Lang: ${prospectData.language}, Country: ${prospectData.country}). Skipping.`
          );
          await updateProspect(
            prospectId,
            { outreachStatus: "template_missing_followup" },
            db,
            logger
          );
          errorCount++;
          continue;
        }

        const templateData = prepareTemplateData(prospectData);
        const options = prepareSendgridOptions(prospectData, "followup");

        try {
          await sendEmail(
            recipientEmail,
            templateId,
            templateData,
            options,
            logger
          );
          // Update status AFTER successful send
          await updateProspect(
            prospectId,
            {
              outreachStatus: nextStatus, // Move to next stage
              lastContactedTimestamp: admin.firestore.Timestamp.now(),
            },
            db,
            logger
          );
          sentCount++;
          emailsSentThisRun++;
          // Optional delay
          // await new Promise(resolve => setTimeout(resolve, 200));
        } catch (emailError) {
          logger.error(
            `Failed to send follow-up email to ${prospectId} (${recipientEmail}):`,
            emailError.message
          );
          // Optionally update status to something like 'followup_send_failed' ?
          errorCount++;
          // Continue to next prospect
        }
      } // end if(dueDate && dueDate <= now)
    } // end for loop
  } catch (error) {
    logger.error("Error during follow-up email phase:", error);
  }
  logger.info(
    `Follow-up email phase complete. Candidates checked: ${candidatesChecked}, Sent: ${sentCount}, Errors: ${errorCount}`
  );
  return { sent: sentCount, errors: errorCount };
}


// Cleans strings to prevent prompt injection

function cleanString(str) {
    // Remove backticks and any surrounding text
    let cleaned = str.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.substring(7);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
  
    // Remove any additional text before the opening brace
    const firstBraceIndex = cleaned.indexOf("{");
    if (firstBraceIndex > 0) {
      cleaned = cleaned.substring(firstBraceIndex);
    }
    cleaned = cleaned.replace(/\/\/[^\n]*\n/g, ""); // removes comments
    return cleaned.trim();
  } 

/**
 * Generates initial email content using Vertex AI for prospects.
 */
async function handleAiInitialEmail() {
  if (!isInitialized) {
    logger.error("handleAiInitialEmail called before initialization.");
    return { generated: 0, errors: 0 };
  }
  logger.info(
    `Starting AI initial email generation process. Max emails: ${MAX_AI_EMAILS_PER_RUN}`
  );
  let generatedCount = 0;
  let errorCount = 0;

  // Define the generative model
  // Ensure model name is correct and supports function calling. Adjust as needed.
  const generativeModel = vertexai.getGenerativeModel({
    model: "gemini-2.0-flash", // Or your preferred Gemini model
    generation_config: { temperature: 0.7 }, // Adjust temp as needed
    safetySettings: [ // Keep safety settings
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
    ],
  });

  try {
    const prospectsToGenerateQuery = db
      .collection("prospects")
      .where("enrichmentSuccess", "==", true)
      .where("aiInitialEmailTemplate", "!=", true) // Check it hasn't been generated
      // Add other conditions if needed (e.g., specific outreach status)
      .where('outreachStatus', '==', OUTREACH_STATUS.PENDING_UPLOAD) // Ensure ready state
      .limit(MAX_AI_EMAILS_PER_RUN);

    const snapshot = await prospectsToGenerateQuery.get();

    if (snapshot.empty) {
      logger.info("No prospects found needing AI initial email generation.");
      return { generated: 0, errors: 0 };
    }

    logger.info(`Found ${snapshot.size} prospects for AI email generation.`);

    // Process sequentially to manage API calls and errors
    for (const doc of snapshot.docs) {
      const prospectId = doc.id;
      const prospectData = { id: prospectId, ...doc.data() };

      // Basic check for essential data needed for the prompt
      if (
        !prospectData.firstName ||
        !prospectData.jobTitle ||
        !prospectData.companyName ||
        !prospectData.country
      ) {
        logger.warn(
          `Prospect ${prospectId} missing essential data (firstName, jobTitle, companyName, or country) for AI prompt. Skipping.`
        );
        await updateProspect(
          prospectId,
          {
            aiInitialEmailTemplate: false, // Mark as not generated
            aiGenerationError: "Missing required fields for prompt",
            aiGenerationTimestamp: admin.firestore.Timestamp.now(),
          },
          db,
          logger
        );
        errorCount++;
        continue;
      }

      const promptText = buildVertexPrompt(prospectData);
      logger.debug(
        `Generated prompt for ${prospectId}:\n${promptText.substring(
          0,
          300
        )}...`
      ); // Log truncated prompt

      try {
        
      const generationConfig = {
        responseMimeType: "application/json",
        responseSchema: vertexAiOutputSchema,
      };
      const req = {
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig,

      };
        
    const response = await generativeModel.generateContent(req);
    const aggregatedResponse = await response.response;
    logger.info(aggregatedResponse)

        // --- Process Vertex AI Response ---
        if (
          aggregatedResponse &&
          aggregatedResponse.candidates &&
          aggregatedResponse.candidates[0].content &&
          aggregatedResponse.candidates[0].content.parts &&
          aggregatedResponse.candidates[0].content.parts[0].text &&
          aggregatedResponse.candidates[0].content.parts[0].text.length > 0 
        ) {
          const generatedArgs = JSON.parse(cleanString(aggregatedResponse.candidates[0].content.parts[0].text));

          // Validate response structure (simple check)
          if (generatedArgs && generatedArgs.subject && generatedArgs.body) {
            logger.info(
              `Successfully generated AI email content for prospect ${prospectId}`
            );
            // Save the structured arguments, not the whole complex response object usually
            await updateProspect(
              prospectId,
              {
                aiInitialEmail: {
                  // Store the parsed arguments
                  subject: generatedArgs.subject,
                  body: generatedArgs.body,
                  // Optionally store model info, timestamp from response etc.
                  usageMetaData: aggregatedResponse.usageMetadata, // Example
                  modelUsed: aggregatedResponse.modelVersion,
                  timestamp: aggregatedResponse.createTime,
                },
                aiInitialEmailTemplate: true, // Mark as generated
                aiGenerationTimestamp: admin.firestore.Timestamp.now(),
                aiGenerationError: admin.firestore.FieldValue.delete(), // Clear previous error
              },
              db,
              logger
            );
            generatedCount++;
          } else {
            logger.error(
              `Vertex AI response for ${prospectId} had unexpected structure in functionCall.args:`,
              generatedArgs
            );
            await updateProspect(
              prospectId,
              {
                aiInitialEmailTemplate: false,
                aiGenerationError: "AI response structure invalid",
                aiGenerationTimestamp: admin.firestore.Timestamp.now(),
              },
              db,
              logger
            );
            errorCount++;
          }
        } else {
          logger.error(
            `Vertex AI response for ${prospectId} did not contain the expected function call. Response:`,
            JSON.stringify(result)
          );
          await updateProspect(
            prospectId,
            {
              aiInitialEmailTemplate: false,
              aiGenerationError: "AI did not return expected function call",
              aiGenerationTimestamp: admin.firestore.Timestamp.now(),
            },
            db,
            logger
          );
          errorCount++;
        }
      } catch (aiError) {
        logger.error(
          `Vertex AI generation failed for prospect ${prospectId}:`,
          aiError
        );
        await updateProspect(
          prospectId,
          {
            aiInitialEmailTemplate: false, // Ensure it's marked as not generated
            aiGenerationError: aiError.message || "Unknown AI Error",
            aiGenerationTimestamp: admin.firestore.Timestamp.now(),
          },
          db,
          logger
        );
        errorCount++;
        // Decide if you want to stop processing others on AI error or continue
      }
      // Optional delay between API calls
      await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
    } // End for loop
  } catch (error) {
    logger.error("Error during AI email generation phase:", error);
    // This catches errors in the query itself or unexpected issues
  }
  logger.info(
    `AI email generation phase complete. Generated: ${generatedCount}, Errors: ${errorCount}`
  );
  return { generated: generatedCount, errors: errorCount };
}

// --- Main Processing Logic (Keep handleEnrichment, handleInitialEmails, handleFollowupEmails) ---
// You will need to MODIFY handleInitialEmails later to USE the AI content.

// --- NEW FUNCTION: Handle AI Initial Email Generation ---

/**
 * Constructs the prompt for Vertex AI based on prospect data.
 * @param {object} prospectData - Prospect data from Firestore.
 * @returns {string} The formatted prompt string.
 */
function buildVertexPrompt(prospectData) {
  // Determine language (default logic, adjust as needed)
  let language = prospectData.language.toLowerCase() === "fr"? "French": prospectData.language || "English"; // Default to English
  if (!prospectData.language) {
    switch (prospectData.country?.toLowerCase()) {
      case "france":
      case ("belgium", "belgique"): // Assuming French Belgium target
      case "canada": // Assuming Quebec target primarily
        language = "French";
        break;
      case ("switzerland", "swiss"):
        // Could be French, German, Italian. Defaulting French for now, refine if needed.
        language = "French";
        break;
      // Add other country/language mappings if necessary
      default:
        language = "English";
    }
    logger.debug(
      `Inferred language ${language} for prospect ${prospectData.id} from country ${prospectData.country}`
    );
  }

  // --- Base Prompt Text (Copied from your previous request) ---
  const basePrompt = `**Role:** You are an expert B2B copywriter specializing in crafting personalized, high-value cold emails for SaaS solutions targeting HR and recruitment professionals.

**Goal:** Generate a concise, compelling, and culturally appropriate initial cold email SUBJECT and BODY for a specific contact based on the provided details. The email should introduce ProRecruit.tech, highlight its value proposition relevant to the contact's likely pain points, and encourage a low-friction next step. Return ONLY the JSON object matching the requested function schema.

**Product Information:**
* **Product Name:** ProRecruit.tech
* **Core Function:** An AI-powered recruitment platform designed to streamline hiring.
* **Key Features & Solutions:** Automated CV Analysis & Ranking (Saves time screening), Psychoanalytical Assessments (Deeper insights for better cultural/soft skill fit), Bias Elimination Technology (Ensures fairness, compliance), Automated Candidate Notifications (Improves candidate experience), Centralized Candidate Management Interface (Organizes the hiring process), ad-hoc email to candidates, tailored technical assessments to the job description.

**Ideal Customer Profile (ICP) Context:**
* **Target Roles:** HR Managers, Talent Acquisition Specialists/Leads, Recruiters (Primary); HR Directors, VPs, CHROs, CEOs/Founders in smaller tech firms (Secondary).
* **Target Industries:** Technology (High priority), Professional Services, Healthcare, Manufacturing, Financial Services.
* **Target Company Size:** SMEs (2-500 employees - Primary), Mid-Market (501-1000 employees - Secondary).
* **Common Pain Points:** Overwhelmed by applicant volume, time-consuming manual screening, difficulty assessing soft skills/fit, concerns about bias/compliance, low quality-of-hire, pressure to fill roles faster, disorganized processes.

**Contact Specific Information:**
* \`[FirstName]\`: ${prospectData.firstName || "Recruiter"}
* \`[LastName]\`: ${prospectData.lastName || ""}
* \`[JobTitle]\`: ${prospectData.jobTitle || "Hiring Professional"}
* \`[occupation]\`: ${prospectData.occupation || ""}
* \`[LinkedInSummary]\`: ${prospectData.summary || ""}
* \`[LinkedInHeadline]\`: ${prospectData.headline || ""}
* \`[industry]\`: ${prospectData.industry || ""}
* \`[experiences]\`: ${prospectData.experiences || ""}
* \`[groups]\`: ${prospectData.groups || ""}
* \`[interests]\`: ${prospectData.interests || ""}
* \`[volunteer_work]\`: ${prospectData.volunteer_work || ""}
* \`[CompanyName]\`: ${
    prospectData.companyName || prospectData.company || ""
  }
* \`[Country]\`: ${prospectData.country || "N/A"}
* \`[Language]\`: ${language}

**Instructions for Email Generation:**
1.  **Personalization:** Use \`[FirstName]\`,\`[LastName]\`, \`[JobTitle]\`, \`[CompanyName]\`, \`[occupation]\`, \`[LinkedInSummary]\`, \`[LinkedInHeadline]\`, \`[industry]\`, \`[experiences]\`, \`[groups]\`, \`[interests]\`, \`[volunteer_work]\`, \`[Language]\`, and \`[Country]\` to personalize the email.
2.  **Value Proposition & Pain Points:** Identify 1-2 probable pain points based on ICP and Contact Info. Connect ProRecruit.tech features directly as solutions.
3.  **Language, Formality, Tone & Etiquette:** Adapt formality based on \`[Country]\` and \`[Language]\` (French: formal 'vous'; US: professional but slightly less formal). Be respectful, helpful, not overly salesy.
4.  **Structure & Best Practices:** Generate SUBJECT (short, personalized, benefit-oriented) and BODY (hook, pain/solution, low-commitment CTA maybe add my booking page url: https://calendar.app.google/YCJdfWBPQKEzvEN69). Keep body paragraphs short. NO GREETING ("Hi Name," or "Name,"). NO SIGN-OFF ("Regards,").
5.  **Output:** Respond ONLY with the JSON object containing 'subject' and 'body' fields as defined in the output schema.
`;
  // --- End Base Prompt Text ---

  // Replace placeholders (basic implementation, refine as needed)
  // Placeholders are already embedded in the template literal above.
  // Add more sophisticated logic here if needed to select pain points etc.

  return basePrompt;
}

// --- Cloud Function Entry Point ---
functions.http("processProspects", async (req, res) => {
  // Initialize on first invocation (or cold start)
  console.log("Initializing... - console", req.get("User-Agent"));
  logger.info("Initializing... - logger", req.get("User-Agent"));
  try {
    initialize();
  } catch (initError) {
    console.error("Initialization failed in entry point:", initError);
    res.status(500).send("Internal Server Error: Initialization Failed");
    return; // Stop execution
  }

  logger.info("Received request to process prospects.", req.get("User-Agent"));

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

    // --- Phase 2: AI Email Generation --- << NEW STEP
    const aiGenerationStats = await handleAiInitialEmail();

    // --- Phase 3: Initial Emails (Needs modification to use AI content) ---
    // For now, it will still try to send based on templates if AI gen failed
    // or if it hasn't run yet for a prospect.
    const initialEmailStats = await handleInitialEmails();

    // --- Phase 4: Follow-up Emails ---
    const followupEmailStats = await handleFollowupEmails();

    logger.info("Prospect processing finished successfully.");
    res.status(200).send(
      `OK. Enriched: ${enrichmentStats.successful}/${enrichmentStats.processed}. ` +
      `AI Generated: ${aiGenerationStats.generated} (Errors: ${aiGenerationStats.errors}). ` + // Added AI stats
        `Initial Sent: ${initialEmailStats.sent} (Errors: ${initialEmailStats.errors}). ` +
        `Follow-up Sent: ${followupEmailStats.sent} (Errors: ${followupEmailStats.errors}).`
    );
  } catch (error) {
    logger.error("Unhandled error in processProspects function:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Export for Functions Framework (if not using HTTP)
// exports.processProspects = processProspects; // Example for background function
