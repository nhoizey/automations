// Heavily inspired from
// https://mxb.dev/blog/syndicating-content-to-twitter-with-netlify-functions/

// Three values to put in environment variables
// MASTODON_INSTANCE: the root URL of the Mastodon instance you're using
// MASTODON_ID: your id, can be found with https://prouser123.me/mastodon-userid-lookup/
// MASTODON_ACCESS_TOKEN: your access token, get it from /settings/applications/new

const fetch = require("node-fetch");
const dotenv = require("dotenv");
const moment = require("moment");
const fs = require("fs");
const { login } = require("masto");

const DAYS = 10;

dotenv.config();

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
    // Keep only recent items
    let items = feed.items.filter((item) =>
      moment(item.date_published).isAfter(moment().subtract(DAYS, "d"))
    );

    // Check existing entries with async filter
    // https://advancedweb.hu/how-to-use-async-functions-with-array-filter-in-javascript/
    items = await asyncFilter(items, async (item) => {
      // check Mastodon for any toots containing the item URL
      // if there are none, publish it.
      let foundToots = [];
      try {
        console.log(`[DEBUG] Check existing message with ${item.url}`);
        const statusesIterable =
          await MastodonClient.accounts.getStatusesIterable(
            process.env.MASTODON_ID,
            {
              excludeReplies: true,
            }
          );
        let lastCreatedAt;
        let nbToots = 0;
        for await (const statuses of statusesIterable) {
          const matches = statuses.filter((status) => {
            lastCreatedAt = status.createdAt;
            return (
              status.application?.name === "nicolas-hoizey.com" &&
              status.card?.url === item.url
            );
          });
          foundToots = foundToots.concat(matches);
          if (moment(lastCreatedAt).isBefore(moment().subtract(DAYS, "d"))) {
            break;
          }
        }
      } catch (error) {
        console.dir(error);
      }

      if (foundToots.length === 0) {
        return true;
      } else {
        console.log(
          `Already on Mastodon: ${item.title} -> ${foundToots[0].url}`
        );
        return false;
      }
    });

    if (!items.length) {
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
      let toot;

      console.log(`
----------------------------------------------------------------------------------
Attempting to post a toot with ${statusText.length} characters:
${statusText}`);

      // Check if there's at least one image attachment
      if (item.hasOwnProperty("attachments") && item.attachments.length > 0) {
        let imagesAttachments = item.attachments.filter((attachment) =>
          // Only keep images
          attachment.mime_type.match("image/")
        );
        if (imagesAttachments.length > 0) {
          let uploadedImages = await Promise.all(
            imagesAttachments.map(async (attachment) => {
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
              try {
                let media = await MastodonClient.mediaAttachments.create({
                  file: imageData,
                  description: attachment.title,
                });
              } catch (error) {
                console.log(error);
              }

              console.log(`[DEBUG] Uploaded with ID ${media.id}`);
              return media.id;
            })
          );

          // Post the toot with the uploaded image(s)
          console.log(`[DEBUG] Post message: ${item.title}`);
          toot = await MastodonClient.statuses.create({
            status: statusText,
            visibility: "public",
            mediaIds: uploadedImages,
            language: item.lang,
          });
        } else {
          // There's no image afterall, simple text toot
          console.log(`[DEBUG] Post message: ${item.title}`);
          toot = await MastodonClient.statuses.create({
            status: statusText,
            visibility: "public",
            language: item.lang,
          });
        }
      } else {
        // Simple text toot
        console.log(`[DEBUG] Post message: ${item.title}`);
        toot = await MastodonClient.statuses.create({
          status: statusText,
          visibility: "public",
          language: item.lang,
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
  // TODO: parse `result` to find potential errors and return accordingly
  // TODO: no need to return
  return { statusCode: 200, body: JSON.stringify(result) };
};

main();