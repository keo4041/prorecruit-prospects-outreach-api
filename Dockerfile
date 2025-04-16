# Use the official Node.js 20 image.
FROM node:20-slim

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure both package.json AND package-lock.json are copied.
# Copying this first prevents re-running npm install on every code change.
COPY package*.json ./

# Install production dependencies.
# If you have native dependencies, you'll need extra tools like build-essentials
RUN npm install --only=production

# Copy local code to the container image.
COPY . .

# Run the web service on container startup. Specify the function target.
# The Functions Framework automatically picks up PORT environment variable.
CMD ["npm", "start"]