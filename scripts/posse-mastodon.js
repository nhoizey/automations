// Heavily inspired from
// https://mxb.dev/blog/syndicating-content-to-twitter-with-netlify-functions/

// Values to put in environment variables
// MASTODON_INSTANCE: the root URL of the Mastodon instance you're using
// MASTODON_ACCESS_TOKEN: your access token, get it from /settings/applications/new

// Native Node modules
const path = require("node:path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Third party dependencies
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const moment = require("moment");
const { login } = require("masto");

// Local dependencies
const download = require("../lib/download.js");

// Cache of toots already sent
const CACHE_FILE = "cache/posse-mastodon.json";
const cache = require(path.join("..", CACHE_FILE));
let cacheUpdated = false;

dotenv.config();

const DAYS = 10;
const TEMPORARY_DIRECTORY =
  process.env.RUNNER_TEMPORARY_DIRECTORY || os.tmpdir();

const main = async () => {
  // Helper Function to return unknown errors
  const handleError = (error) => {
    const msg = Array.isArray(error) ? error[0].message : error.message;
    process.exitCode = 1;
    // TODO: no need to return
    return status(422, String(msg));
  };

  // Helper Function to return function status
  const status = (code, msg) => {
    console.log(`[${code}] ${msg}`);
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
    // Keep only recent items that have not been POSSEd yet
    let items = feed.items.filter(
      (item) =>
        moment(item.date_published).isAfter(moment().subtract(DAYS, "d")) &&
        !cache.hasOwnProperty(item.url)
    );

    if (items.length === 0) {
      // TODO: no need to return
      return status(200, "No item found to process.");
    }

    const oldestItem = items.pop();
    try {
      return publishItem(oldestItem);
    } catch (error) {
      return handleError(error);
    }
  };

  // Push a new toot to Mastodon
  const publishItem = async (item) => {
    try {
      // TODO: shorten the status text if it's too long, or let the API call fail (current behavior)
      let statusText = item.content_text;
      // Safeguard for test platform
      if (process.env.MASTODON_INSTANCE.match("mastodon.hsablonniere.com")) {
        statusText = statusText.replaceAll("@", "%");
      }
      let toot;

      console.log(`Posting toot "${item.title}"`);

      // Check if there's at least one image attachment
      if (item.hasOwnProperty("attachments") && item.attachments.length > 0) {
        let imagesAttachments = item.attachments.filter((attachment) =>
          // Only keep images
          attachment.mime_type.match("image/")
        );
        if (imagesAttachments.length > 0) {
          let uploadedImages = await Promise.all(
            imagesAttachments.map(async (attachment) => {
              let media;
              let imageFile = path.join(
                TEMPORARY_DIRECTORY,
                `image-${crypto.randomUUID()}`
              );
              try {
                await download(attachment.url, imageFile);
                try {
                  media = await MastodonClient.mediaAttachments.create({
                    file: fs.createReadStream(imageFile),
                    description: attachment.title,
                  });
                  // console.log(`Uploaded with ID ${media.id}`);
                  await fs.unlink(imageFile, () => {
                    // console.log(`${imageFile} deleted.`);
                  });
                  return media.id;
                } catch (error) {
                  console.log(error);
                }
              } catch (e) {
                console.log(e.message);
              }
            })
          );

          // Post the toot with the uploaded image(s)
          toot = await MastodonClient.statuses.create({
            status: statusText,
            visibility: "public",
            mediaIds: uploadedImages,
            language: item.lang,
          });
        } else {
          // There's no image afterall, simple text toot
          toot = await MastodonClient.statuses.create({
            status: statusText,
            visibility: "public",
            language: item.lang,
          });
        }
      } else {
        // Simple text toot
        toot = await MastodonClient.statuses.create({
          status: statusText,
          visibility: "public",
          language: item.lang,
        });
      }
      if (toot) {
        cache[item.url] = toot.url;
        cacheUpdated = true;
        return status(
          200,
          `Item "${item.title}" successfully posted to Mastodon: ${toot.uri}`
        );
      } else {
        // TODO: get the actual issue from each call
        return status(422, "Error posting to Mastodon API.");
      }
    } catch (err) {
      return handleError(err);
    }
  };

  const MastodonClient = await login({
    url: process.env.MASTODON_INSTANCE,
    accessToken: process.env.MASTODON_ACCESS_TOKEN,
  });

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
  if (cacheUpdated) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), {
      encoding: "utf8",
    });
  }
  // TODO: parse `result` to find potential errors and return accordingly
  // TODO: no need to return
  return { statusCode: 200, body: JSON.stringify(result) };
};

main();
