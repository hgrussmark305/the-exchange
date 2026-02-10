const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

/**
 * STRIPE REVENUE INTEGRATION
 * Connect real payment processing to ventures
 */

class StripeIntegration {
  constructor(database, protocol) {
    this.db = database;
    this.protocol = protocol;
  }

  /**
   * Create Stripe checkout for venture product/service
   */
  async createCheckoutSession({ ventureId, amount, description, successUrl, cancelUrl }) {
    try {
      const venture = await this.protocol.getVenture(ventureId);
      
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: venture.title,
              description: description
            },
            unit_amount: amount * 100 // Convert to cents
          },
          quantity: 1
        }],
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          ventureId: ventureId,
          platform: 'the-exchange'
        }
      });

      console.log(`💳 Checkout session created for ${venture.title}: $${amount}`);
      
      return {
        sessionId: session.id,
        url: session.url
      };
    } catch (error) {
      console.error('Stripe checkout error:', error);
      throw error;
    }
  }

  /**
   * Handle Stripe webhook for successful payments
   */
  async handleWebhook(event) {
    console.log(`📨 Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.handleSuccessfulPayment(event.data.object);
        break;
      
      case 'payment_intent.succeeded':
        console.log('✅ Payment succeeded:', event.data.object.amount / 100);
        break;
      
      case 'payment_intent.payment_failed':
        console.log('❌ Payment failed');
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Process successful payment and distribute revenue
   */
  async handleSuccessfulPayment(session) {
    const ventureId = session.metadata.ventureId;
    const amount = session.amount_total / 100; // Convert from cents

    console.log(`💰 Processing payment: $${amount} for venture ${ventureId}`);

    // Process revenue through the protocol
    const result = await this.protocol.processStandardVentureRevenue({
      ventureId,
      amount,
      source: 'stripe',
      verificationMethod: 'stripe_verified',
      transactionId: session.payment_intent
    });

   console.log(`✅ Revenue distributed:`);
    console.log(`   Platform fee: $${result.platformFee}`);
    console.log(`   Bot payouts: $${result.totalDistributed}`);
    if (result.distributions && result.distributions.length > 0) {
      console.log(`   Participants: ${result.distributions.length} bots`);
      result.distributions.forEach(d => {
        console.log(`      ${d.botName}: $${d.amount}`);
      });
    }

    return result;
  }

  /**
   * Create Stripe Connect account for bot owner
   */
  async createConnectedAccount(humanId, email) {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        metadata: {
          humanId: humanId,
          platform: 'the-exchange'
        }
      });

      console.log(`🔗 Stripe Connect account created for user ${humanId}`);

      return account;
    } catch (error) {
      console.error('Stripe Connect error:', error);
      throw error;
    }
  }

  /**
   * Transfer funds to bot owner's connected account
   */
  async transferToOwner(humanId, amount) {
    try {
      const human = await this.protocol.getHuman(humanId);
      
      if (!human.stripe_account_id) {
        throw new Error('No Stripe account connected');
      }

      const transfer = await stripe.transfers.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        destination: human.stripe_account_id,
        description: 'Bot earnings from The Exchange'
      });

      console.log(`💸 Transferred $${amount} to user ${humanId}`);

      return transfer;
    } catch (error) {
      console.error('Transfer error:', error);
      throw error;
    }
  }

  /**
   * Get revenue analytics for a venture
   */
  async getVentureRevenue(ventureId) {
    const transactions = await this.db.query(`
      SELECT * FROM transactions 
      WHERE venture_id = ? AND type = 'revenue'
      ORDER BY timestamp DESC
    `, [ventureId]);

    const totalRevenue = transactions.reduce((sum, t) => sum + t.amount, 0);
    const avgTransaction = totalRevenue / transactions.length || 0;

    return {
      totalRevenue,
      transactionCount: transactions.length,
      avgTransaction,
      transactions: transactions.slice(0, 10)
    };
  }
}

module.exports = StripeIntegration;