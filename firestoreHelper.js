const admin = require('firebase-admin');

// Initialize Firestore (do this once in index.js ideally)
// admin.initializeApp();
// const db = admin.firestore();

/**
 * Updates a prospect document in Firestore.
 * @param {string} prospectId - Document ID (email).
 * @param {object} updateData - Data to update.
 * @param {object} db - Firestore instance.
 * @param {object} logger - Logger instance.
 * @returns {Promise<void>}
 */
async function updateProspect(prospectId, updateData, db, logger) {
    if (!prospectId || !updateData || Object.keys(updateData).length === 0) {
        logger.warn('Attempted to update prospect with invalid ID or empty data.');
        return;
    }
    const prospectRef = db.collection('prospects').doc(prospectId);
    try {
        await prospectRef.update({
            ...updateData,
            lastModifiedTimestamp: admin.firestore.Timestamp.now() // Add a last modified timestamp
        });
        logger.info(`Successfully updated prospect ${prospectId}.`);
    } catch (error) {
        logger.error(`Error updating prospect ${prospectId} in Firestore:`, error);
        // Decide if re-throwing is needed
    }
}

module.exports = { updateProspect };