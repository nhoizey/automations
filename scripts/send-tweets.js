// Heavily inspired from
// https://mxb.dev/blog/syndicating-content-to-twitter-with-netlify-functions/

// TODO: manage offline

const myTwitterUsername = "nhoizey";

const fetch = require("node-fetch");
const dotenv = require("dotenv");
const moment = require("moment");
const Twitter = require("twitter");
const bent = require("bent");
const getBuffer = bent("buffer");

dotenv.config();

// Configure Twitter API Client
const twitter = new Twitter({
  consumer_key: process.env.TWITTER_API_KEY,
  consumer_secret: process.env.TWITTER_API_SECRET_KEY,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

// Helper Function to return unknown errors
const handleError = (error) => {
  const msg = Array.isArray(error) ? error[0].message : error.message;
  process.exitCode = 1;
  // TODO: no need to return
  return status(422, String(msg));
};

// Helper Function to return function status
const status = (code, msg) => {
  console.log(`
[${code}] ${msg}`);
  // TODO: no need to return
  return {
    statusCode: code,
    body: msg,
  };
};

const asyncFilter = async (items, predicate) => {
  const results = await Promise.all(items.map(predicate));

  return items.filter((_v, index) => results[index]);
};

const processFeed = async (feed) => {
  // Keep items published less than 7 days ago
  let items = feed.items.filter((item) =>
    moment(item.date_published).isAfter(moment().subtract(6, "d"))
  );

  // Check exisiting entries with async filter
  // https://advancedweb.hu/how-to-use-async-functions-with-array-filter-in-javascript/
  items = await asyncFilter(items, async (item) => {
    // check twitter for any tweets containing the item URL in last 7 days (API limit).
    // TODO: keep a cache of sent tweets instead of searching with the API
    // if there are none, publish it.
    const q = await twitter.get("search/tweets", {
      q: `${item.url} from:${myTwitterUsername}`,
      result_type: "recent",
    });
    if (q.statuses && q.statuses.length === 0) {
      return true;
    } else {
      console.log(`
Already on Twitter: ${item.title}
  https://twitter.com/${myTwitterUsername}/status/${q.statuses[0].id_str}`);
      return false;
    }
  });

  if (!items.length) {
    // TODO: no need to return
    return status(200, "No item found to process.");
  }

  const latestItem = items[0];

  try {
    return publishItem(latestItem);
  } catch (error) {
    return handleError(error);
  }
};

// Push a new tweet to Twitter
const publishItem = async (item) => {
  try {
    // TODO: shorten the status text if it's too long, or let the API call fail (current behavior)
    let statusText = item.content_text;

    // Add zero width space to CSS At-rules
    // https://developer.mozilla.org/en-US/docs/Web/CSS/At-rule
    [
      "charset",
      "import",
      "namespace",
      "media",
      "supports",
      "page",
      "font-face",
      "keyframes",
      "counter-style",
      "property",
      "layer",
    ].forEach((atRule) => {
      statusText = statusText.replace(`@{atRule}`, `@​{atRule}`);
    });
    let tweet;

    console.log(
      `Attempting to post a tweet with ${statusText.length} characters…

${statusText}`
    );

    // Check if there's at least one image attachment
    if (item.hasOwnProperty("attachments") && item.attachments.length > 0) {
      let imagesAttachments = item.attachments.filter((attachment) =>
        // Only keep images
        attachment.mime_type.match("image/")
      );
      if (imagesAttachments.length > 0) {
        let uploadedImages = await Promise.all(
          imagesAttachments.map(async (attachment) => {
            // Get the image as a base64 string
            let imageBuffer = await getBuffer(attachment.url);
            let imageData = await imageBuffer.toString("base64");

            // TODO: prevent sending tweet if media too large
            if (imageData.length > 5000000) {
              console.error(
                `Weight ~ ${
                  Math.round(imageData.length / 100000) / 10
                } MB > 5 MB: ${attachment.url}`
              );
            }

            // Upload the image to Twitter
            let media = await twitter.post("media/upload", {
              media_data: imageData,
            });
            return media.media_id_string;
          })
        );

        // Post the tweet with the uploaded image(s)
        tweet = await twitter.post("statuses/update", {
          status: statusText,
          media_ids: uploadedImages.join(","), // Pass the media id string(s)
        });
      } else {
        // There's no image afterall, simple text tweet
        tweet = await twitter.post("statuses/update", {
          status: statusText,
        });
      }
    } else {
      // Simple text tweet
      tweet = await twitter.post("statuses/update", {
        status: statusText,
      });
    }
    if (tweet) {
      return status(
        200,
        `Item "${item.title}" successfully posted to Twitter: https://twitter.com/user/status/${tweet.id_str}`
      );
    } else {
      // TODO: get the actual issue from each call
      return status(422, "Error posting to Twitter API.");
    }
  } catch (err) {
    return handleError(err);
  }
};

const main = async () => {
  // TODO: use Promise.allSettled to continue even if one is rejected
  let result = await Promise.all(
    [
      "https://nicolas-hoizey.com/feeds/twitter/links.json",
      "https://nicolas-hoizey.com/feeds/twitter/notes.json",
      "https://nicolas-hoizey.com/feeds/twitter/billets.json",
    ].map(async (feedUrl) => {
      console.log(`Fetching ${feedUrl} …`);
      return fetch(feedUrl)
        .then((response) => response.json())
        .then(processFeed)
        .catch(handleError);
    })
  );
  // TODO: parse `result` to find potential errors and return accordingly
  // TODO: no need to return
  return { statusCode: 200, body: JSON.stringify(result) };
};

main();
