// All the copy and knobs for the DM funnel live here.
// Every value can be overridden with an environment variable so you can
// tweak wording on the deploy host without touching code.

const env = (key, fallback) => process.env[key] ?? fallback;

export default {
  // The discount code your followers receive. Create it in Shopify first
  // (Discounts -> Create discount -> Amount off order -> 15%).
  discountCode: env('DISCOUNT_CODE', 'RABBIT15'),

  // Where the "Shop Now" button points.
  shopUrl: env('SHOP_URL', 'https://rinkrabbit.com'),

  // If someone comments this word on any post, the bot DMs them the same
  // welcome funnel (comment-to-DM is the officially supported stand-in for
  // the follow trigger). Case-insensitive.
  commentKeyword: env('COMMENT_KEYWORD', 'DISCOUNT'),

  messages: {
    welcome: env(
      'MSG_WELCOME',
      "Hey there! Thanks for the follow — welcome to the Rink Rabbit crew. 🏒\n\n" +
        "To say thanks, we'd love to get you an exclusive discount.\n\n" +
        'Let me know if you\'re interested!'
    ),
    welcomeButton: env('MSG_WELCOME_BUTTON', 'Yes, send it over!'),

    askEmail: env(
      'MSG_ASK_EMAIL',
      "Of course!\n\nDrop your email right here and we'll send the code your way."
    ),

    // {{code}} is replaced with discountCode at send time.
    deliverCode: env(
      'MSG_DELIVER_CODE',
      'Use {{code}} for 15% off anything in the store for the next 24 hours!\n\n' +
        'Let us know if you have any questions. 🐇\n\n' +
        'Shop the lineup ⤵️'
    ),
    shopButton: env('MSG_SHOP_BUTTON', 'Shop Now'),

    // Sent when someone types something we don't recognize mid-funnel.
    emailNudge: env(
      'MSG_EMAIL_NUDGE',
      "Almost there! Just reply with your email address and we'll send your discount code right over."
    ),
  },
};
