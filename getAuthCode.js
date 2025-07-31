import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function getAccessToken(authCode) {
  const response = await axios.post('https://login.microsoftonline.com/common/oauth2/v2.0/token', new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    code: authCode,
    redirect_uri: 'http://localhost:5500', // Ensure this matches the redirect URI in your app
    grant_type: 'authorization_code'
  }));

  const { access_token, refresh_token } = response.data;

  console.log('Access Token:', access_token);
  console.log('Refresh Token:', refresh_token);

  // You can now use the access token to authenticate with Microsoft Graph
}

getAccessToken('<YOUR_AUTHORIZATION_CODE>');
