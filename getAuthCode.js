import { google } from 'googleapis';
import dotenv from 'dotenv';
import readlineSync from 'readline-sync';

// Load environment variables
dotenv.config();

const clientId = process.env.WEB_CLIENT_ID;
const clientSecret = process.env.WEB_CLIENT_SECRET;
const redirectUris = process.env.WEB_REDIRECT_URIS.split(',');

// Set up the OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  clientId,
  clientSecret,
  redirectUris[0]  // Assuming you have one redirect URI
);

// Generate an authentication URL
const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',  // Request offline access to get a refresh token
  scope: scopes,
});

console.log('Authorize this app by visiting this url:', authUrl);

// Get the authorization code from the user
const code = readlineSync.question('Enter the code from that page here: ');

// Exchange the code for tokens
async function getTokens() {
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    console.log('Tokens acquired:');
    console.log('Access Token:', tokens.access_token);
    console.log('Refresh Token:', tokens.refresh_token); // This is the refresh token!
  } catch (error) {
    console.error('Error exchanging code for token:', error);
  }
}

getTokens();
