var bodyParser = require('body-parser');
var dotenv = require('dotenv');
var express = require('express');
var fs = require('fs');
var request = require('request');
var slack = require('slack');
var SpotifyWebApi = require('spotify-web-api-node');
var admin = require('firebase-admin');
var serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_DATABASE_NAME}.firebaseio.com/`
});

var spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_KEY,
  clientSecret: process.env.SPOTIFY_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

var db = admin.database();
var ref = db.ref('tapbox');
var tokenRef = ref.child('tokens');

ref.on(
  'value',
  function(tokens) {
    if (tokens.val()) {
      spotifyApi.setAccessToken(tokens.val().tokens['access_token']);
      spotifyApi.setRefreshToken(tokens.val().tokens['refresh_token']);
    }
  },
  function(errorObject) {
    console.log('The read failed: ' + errorObject.code);
  }
);
dotenv.load();

function slackResponse(res, message) {
  return res.send(message);
}

var app = express();
app.use(bodyParser.json());
app.use(
  bodyParser.urlencoded({
    extended: true
  })
);

// Cron job hits this endpoint every 30 minutes to refresh access token.
app.get('/refresh_session', function(req, res) {
  if (spotifyApi.getAccessToken()) {
    spotifyApi.refreshAccessToken().then(
      function(data) {
        spotifyApi.setAccessToken(data.body['access_token']);
        tokenRef.update({ access_token: data.body['access_token'] });

        if (data.body['refresh_token']) {
          spotifyApi.setRefreshToken(data.body['refresh_token']);
          tokenRef.update({ refresh_token: data.body['refresh_token'] });
        }
        return res.sendStatus(200);
      },
      function(err) {
        console.log('Could not refresh the token!', err.message);
        return res.send(err);
      }
    );
  }
});

app.get('/', function(req, res) {
  if (spotifyApi.getAccessToken()) {
    return res.send('You are logged in.');
  }
  return res.send('<a href="/authorize">Authorize</a>');
});

app.get('/authorize', function(req, res) {
  var scopes = ['playlist-modify-public', 'playlist-modify-private'];
  var state = new Date().getTime();
  var authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);
  res.redirect(authorizeURL);
});

app.get('/callback', function(req, res) {
  spotifyApi.authorizationCodeGrant(req.query.code).then(
    function(data) {
      spotifyApi.setAccessToken(data.body['access_token']);
      spotifyApi.setRefreshToken(data.body['refresh_token']);
      tokenRef.set({
        access_token: data.body['access_token'],
        refresh_token: data.body['refresh_token']
      });
      return res.redirect('/');
    },
    function(err) {
      return res.send(err);
    }
  );
});

app.use('/store', function(req, res, next) {
  if (req.body.token !== process.env.SLACK_TOKEN) {
    return slackResponse(res.status(500), 'Cross site request forgerizzle!');
  }
  next();
});

app.post('/store', function(req, res) {
  spotifyApi.refreshAccessToken().then(
    function(data) {
      spotifyApi.setAccessToken(data.body['access_token']);
      tokenRef.update({ access_token: data.body['access_token'] });
      if (data.body['refresh_token']) {
        spotifyApi.setRefreshToken(data.body['refresh_token']);
        tokenRef.update({ refresh_token: data.body['refresh_token'] });
      }
      if (req.body.text.trim().length === 0) {
        return res.send(
          'Enter the name of a song and the name of the artist, separated by a "-"\nExample: Blue (Da Ba Dee) - Eiffel 65'
        );
      }
      var text = req.body.text;
      if (text.indexOf(' - ') === -1) {
        var query = 'track:' + text;
      } else {
        var pieces = text.split(' - ');
        var query = 'artist:' + pieces[1].trim() + ' track:' + pieces[0].trim();
      }
      spotifyApi
        .search(query, ['track'], { limit: 5 })
        .then(
          function(data) {
            var results = data.body.tracks.items;
            if (results.length === 0) {
              return slackResponse(res, 'Could not find that track.');
            }
            var track = results[0];
            spotifyApi
              .addTracksToPlaylist(
                process.env.SPOTIFY_USERNAME,
                process.env.SPOTIFY_PLAYLIST_ID,
                ['spotify:track:' + track.id]
              )
              .then(
                function(data) {
                  var message =
                    'Track added: *' +
                    track.name +
                    '* by *' +
                    track.artists[0].name +
                    '*';
                  slack.chat.postMessage(
                    {
                      token: process.env.SLACK_TOKEN_BOT,
                      channel: process.env.SLACK_CHANNEL,
                      text: track.uri,
                      username: process.env.SLACK_USERNAME,
                      icon_emoji: process.env.SLACK_EMOJI_ICON
                    },
                    (err, data) => {
                      console.log(err, data);
                    }
                  );

                  return slackResponse(res, message);
                },
                function(err) {
                  return slackResponse(res, err.message);
                }
              );
          },
          function(err) {
            return slackResponse(res, err.message);
          }
        )
        .catch(function(error) {
          return slackResponse(res, error.message);
        });
    },
    function(err) {
      return slackResponse(
        res,
        'You were not authorized, authorize here: https://tapbox.herokuapp.com/authorize'
      );
    }
  );
});

app.set('port', process.env.PORT || 5000);
app.listen(app.get('port'));
