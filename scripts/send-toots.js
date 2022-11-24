// Heavily inspired from
// https://mxb.dev/blog/syndicating-content-to-twitter-with-netlify-functions/

// TODO: manage offline

const MY_MASTODON_HANDLE = "@nhoizey@mamot.fr";
const MY_MASTODON_SERVER = "https://mamot.fr";
const MY_MASTODON_ID = "000262395"; // https://prouser123.me/mastodon-userid-lookup/

const fetch = require("node-fetch");
const dotenv = require("dotenv");
const moment = require("moment");
const Mastodon = require("mastodon");
const bent = require("bent");
const getBuffer = bent("buffer");

dotenv.config();

// Configure Mastodon API Client
const MastodonClient = new Mastodon({
  access_token: process.env.MASTODON_ACCESS_TOKEN,
  timeout_ms: 60 * 1000, // optional HTTP request timeout to apply to all requests.
  api_url: `${MY_MASTODON_SERVER}/api/v1/`,
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

  // Check existing entries with async filter
  // https://advancedweb.hu/how-to-use-async-functions-with-array-filter-in-javascript/
  items = await asyncFilter(items, async (item) => {
    // check Mastodon for any toots containing the item URL
    // if there are none, publish it.
    console.log(`[DEBUG] Check existing message with ${item.url}`);
    const q = await MastodonClient.get("search", {
      type: "statuses",
      account_id: MY_MASTODON_ID,
      q: item.url,
    });
    console.dir(q);
    if (q.statuses && q.statuses.length === 0) {
      return true;
    } else {
      console.log(`
Already on Mastodon: ${item.title}
  ${q.statuses[0].url}`);
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

// Push a new toot to Mastodon
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
    let toot;

    console.log(
      `Attempting to post a toot with ${statusText.length} characters…

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
            // let imageBuffer = await getBuffer(attachment.url);
            // let imageData = await imageBuffer.toString("base64");
            console.log(`[DEBUG] Uploading ${attachment.url}`);
            let imageData = fs.createReadStream(attachment.url);

            // TODO: prevent sending toot if media too large
            if (imageData.length > 5000000) {
              console.error(
                `Weight ~ ${
                  Math.round(imageData.length / 100000) / 10
                } MB > 5 MB: ${attachment.url}`
              );
            }

            // Upload the image to Mastodon
            let media = await MastodonClient.post("media", {
              file: imageData,
            });
            console.log(`[DEBUG] Uploaded with ID ${media.data.id}`);
            return media.data.id;
          })
        );

        // Post the toot with the uploaded image(s)
        console.log(`[DEBUG] Post message: ${statusText}`);
        toot = await MastodonClient.post("statuses", {
          status: statusText,
          media_ids: uploadedImages.join(","), // Pass the media id string(s)
        });
      } else {
        // There's no image afterall, simple text toot
        console.log(`[DEBUG] Post message: ${statusText}`);
        toot = await MastodonClient.post("statuses", {
          status: statusText,
        });
      }
    } else {
      // Simple text toot
      console.log(`[DEBUG] Post message: ${statusText}`);
      toot = await MastodonClient.post("statuses", {
        status: statusText,
      });
    }
    if (toot) {
      return status(
        200,
        `Item "${item.title}" successfully posted to Mastodon: ${toot.url}`
      );
    } else {
      // TODO: get the actual issue from each call
      return status(422, "Error posting to Mastodon API.");
    }
  } catch (err) {
    return handleError(err);
  }
};

const main = async () => {
  // TODO: use Promise.allSettled to continue even if one is rejected
  let result = await Promise.all(
    [
      "https://nicolas-hoizey.com/feeds/mastodon/links.json",
      "https://nicolas-hoizey.com/feeds/mastodon/notes.json",
      "https://nicolas-hoizey.com/feeds/mastodon/billets.json",
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
