const Stripe = require('stripe');

class StripeIntegration {
  constructor(protocol, db) {
    this.protocol = protocol;
    this.db = db;

    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      console.warn('STRIPE_SECRET_KEY not set - Stripe integration disabled');
      this.stripe = null;
    } else {
      this.stripe = new Stripe(secretKey);
    }

    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  }

  /**
   * Create a Stripe Checkout session for a venture
   */
  async createCheckoutSession({ ventureId, amount, description, successUrl, cancelUrl }) {
    if (!this.stripe) {
      throw new Error('Stripe is not configured');
    }

    const venture = await this.protocol.getVenture(ventureId);
    if (!venture) {
      throw new Error('Venture not found');
    }

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: venture.title,
            description: description || venture.description
          },
          unit_amount: Math.round(amount * 100) // Stripe expects cents
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: successUrl || `${process.env.BASE_URL || 'http://localhost:3000'}/?payment=success`,
      cancel_url: cancelUrl || `${process.env.BASE_URL || 'http://localhost:3000'}/?payment=cancelled`,
      metadata: {
        ventureId: ventureId,
        amount: amount.toString()
      }
    });

    console.log(`\n💳 Checkout session created for: ${venture.title}`);
    console.log(`   Amount: $${amount}`);
    console.log(`   Session ID: ${session.id}`);

    return { sessionId: session.id, url: session.url };
  }

  /**
   * Handle incoming Stripe webhook events
   * IMPORTANT: req.body must be the raw body (Buffer), not JSON-parsed
   */
  async handleWebhook(rawBody, signature) {
    if (!this.stripe) {
      throw new Error('Stripe is not configured');
    }

    let event;

    // Verify webhook signature if secret is configured
    if (this.webhookSecret) {
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        throw new Error(`Webhook signature verification failed: ${err.message}`);
      }
    } else {
      // No webhook secret - parse raw body directly (development only)
      console.warn('No STRIPE_WEBHOOK_SECRET set - skipping signature verification');
      event = JSON.parse(rawBody.toString());
    }

    console.log(`\n📨 Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleSuccessfulPayment(event.data.object);
        break;

      case 'payment_intent.succeeded':
        console.log(`   Payment intent succeeded: ${event.data.object.id}`);
        break;

      case 'payment_intent.payment_failed':
        console.log(`   Payment failed: ${event.data.object.id}`);
        console.log(`   Reason: ${event.data.object.last_payment_error?.message}`);
        break;

      default:
        console.log(`   Unhandled event type: ${event.type}`);
    }

    return { received: true, type: event.type };
  }

  /**
   * Handle a successful checkout session - distribute revenue to bots
   */
  async handleSuccessfulPayment(session) {
    console.log(`\n💰 Processing successful payment...`);
    console.log(`   Session ID: ${session.id}`);
    console.log(`   Payment Status: ${session.payment_status}`);

    const ventureId = session.metadata?.ventureId;
    const amount = parseFloat(session.metadata?.amount) || (session.amount_total / 100);

    if (!ventureId) {
      console.error('   ERROR: No ventureId in session metadata - cannot distribute revenue');
      return;
    }

    if (!amount || amount <= 0) {
      console.error('   ERROR: Invalid amount in session metadata');
      return;
    }

    console.log(`   Venture ID: ${ventureId}`);
    console.log(`   Amount: $${amount}`);

    const venture = await this.protocol.getVenture(ventureId);
    if (!venture) {
      console.error(`   ERROR: Venture ${ventureId} not found`);
      return;
    }

    console.log(`   Venture: ${venture.title}`);
    console.log(`   Type: ${venture.venture_type}`);

    try {
      let result;
      if (venture.venture_type === 'standard') {
        result = await this.protocol.processStandardVentureRevenue({
          ventureId,
          amount,
          source: `Stripe payment (${session.id})`,
          verificationMethod: 'stripe'
        });
      } else {
        result = await this.protocol.processPooledVentureRevenue({
          ventureId,
          amount,
          source: `Stripe payment (${session.id})`
        });
      }

      console.log(`   ✅ Revenue distributed successfully!`);
      console.log(`   Platform fee: $${result.platformFee.toFixed(2)}`);
      console.log(`   Distributed: $${result.distributable.toFixed(2)}`);

      return result;
    } catch (err) {
      console.error(`   ERROR distributing revenue: ${err.message}`);
      throw err;
    }
  }
}

module.exports = StripeIntegration;
