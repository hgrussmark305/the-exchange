const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
/**
 * STRIPE REVENUE INTEGRATION
 * Connect real payment processing to ventures
 */

class StripeIntegration {
  constructor(database, protocol) {
    this.db = database;
    this.protocol = protocol;
    this.bountyBoard = null; // Set after BountyBoard is created
    this.jobEngine = null;   // Set after JobEngine is created
  }

  setBountyBoard(bountyBoard) {
    this.bountyBoard = bountyBoard;
  }

  setJobEngine(jobEngine) {
    this.jobEngine = jobEngine;
  }

  /**
   * Create Stripe Checkout for a bounty posting
   */
  async createBountyCheckout({ bountyId, title, amountCents, posterEmail, baseUrl }) {
    const platformFee = Math.round(amountCents * 0.15);
    const totalCents = amountCents + platformFee;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: posterEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Bounty: ${title}`,
              description: `AI bot will complete this task. Budget: $${(amountCents / 100).toFixed(2)}`
            },
            unit_amount: amountCents
          },
          quantity: 1
        },
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Platform fee (15%)',
              description: 'BotXchange marketplace fee'
            },
            unit_amount: platformFee
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: `${baseUrl}/bounties?payment=success&bountyId=${bountyId}`,
      cancel_url: `${baseUrl}/post-bounty?payment=cancelled`,
      metadata: {
        type: 'bounty',
        bountyId: bountyId,
        platform: 'the-exchange'
      }
    });

    console.log(`💳 Bounty checkout created: "${title}" — $${(totalCents / 100).toFixed(2)} total`);
    return { sessionId: session.id, url: session.url, totalCents };
  }

  /**
   * Create Stripe Checkout for a job posting
   */
  async createJobCheckout({ jobId, title, amountCents, posterEmail, baseUrl }) {
    const platformFee = Math.round(amountCents * 0.15);
    const totalCents = amountCents + platformFee;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: posterEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Job: ${title}`,
              description: `AI bots will complete this task. Budget: $${(amountCents / 100).toFixed(2)}`
            },
            unit_amount: amountCents
          },
          quantity: 1
        },
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Platform fee (15%)',
              description: 'BotXchange marketplace fee'
            },
            unit_amount: platformFee
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: `${baseUrl}/jobs?payment=success`,
      cancel_url: `${baseUrl}/post-job?payment=cancelled`,
      metadata: {
        type: 'job',
        jobId: jobId,
        platform: 'the-exchange'
      }
    });

    console.log(`💳 Job checkout created: "${title}" — $${(totalCents / 100).toFixed(2)} total`);
    return { sessionId: session.id, url: session.url, totalCents };
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
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.metadata?.type === 'bounty') {
          await this.handleBountyPayment(session);
        } else if (session.metadata?.type === 'job') {
          await this.handleJobPayment(session);
        } else if (session.metadata?.type === 'founder_credits') {
          await this.handleCreditPayment(session);
        } else {
          await this.handleSuccessfulPayment(session);
        }
        break;
      }
      
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
    console.log(`   Platform fee: $${result.platformFee.toFixed(2)}`);
    console.log(`   Bot payouts: $${result.distributable.toFixed(2)}`);
    console.log(`   Participants: ${result.participants} bots`);

    return result;
  }

  /**
   * Handle bounty payment — activate the bounty and start matching
   */
  async handleBountyPayment(session) {
    const bountyId = session.metadata.bountyId;
    console.log(`💰 Bounty payment received for ${bountyId}`);

    // Activate the bounty
    await this.db.query(
      "UPDATE bounties SET status = 'open', stripe_session_id = ?, stripe_payment_intent = ? WHERE id = ? AND status = 'pending_payment'",
      [session.id, session.payment_intent, bountyId]
    );

    console.log(`   ✅ Bounty activated: ${bountyId}`);

    // Trigger auto-matching
    if (this.bountyBoard) {
      setTimeout(() => {
        this.bountyBoard.autoMatch(bountyId).catch(err => {
          console.error(`   Auto-match error after payment: ${err.message}`);
        });
      }, 5000);
    }
  }

  /**
   * Handle job payment — activate the job and start matching
   */
  async handleJobPayment(session) {
    const jobId = session.metadata.jobId;
    console.log(`💰 Job payment received for ${jobId}`);

    // Store Stripe references on the job
    await this.db.query(
      "UPDATE jobs SET stripe_session_id = ?, stripe_payment_intent = ? WHERE id = ?",
      [session.id, session.payment_intent, jobId]
    );

    // Activate the job via JobEngine
    if (this.jobEngine) {
      await this.jobEngine.activateJob(jobId);
    } else {
      // Fallback: directly update status
      await this.db.query(
        "UPDATE jobs SET status = 'open' WHERE id = ? AND status = 'pending_payment'",
        [jobId]
      );
      console.log(`   ✅ Job activated (fallback): ${jobId}`);
    }
  }

  /**
   * Refund a job payment via Stripe
   */
  async handleJobRefund(jobId) {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
    if (!jobs.length) throw new Error('Job not found');
    const job = jobs[0];

    if (!job.stripe_payment_intent) {
      throw new Error('No Stripe payment found for this job');
    }

    // Only allow refund for jobs not yet paid out
    if (job.status === 'paid') {
      throw new Error('Cannot refund a job that has already been paid to bots');
    }

    const refund = await stripe.refunds.create({
      payment_intent: job.stripe_payment_intent,
      reason: 'requested_by_customer'
    });

    await this.db.query(
      "UPDATE jobs SET status = 'refunded', stripe_refund_id = ? WHERE id = ?",
      [refund.id, jobId]
    );

    // Clean up any in-progress work
    await this.db.query("DELETE FROM job_steps WHERE job_id = ?", [jobId]);
    await this.db.query("DELETE FROM job_collaborators WHERE job_id = ?", [jobId]);

    console.log(`💸 Job ${jobId} refunded: ${refund.id}`);
    return { refundId: refund.id, status: refund.status };
  }

  /**
   * Create Stripe Checkout for founder credit purchase
   */
  async createCreditCheckout({ founderId, amountCents, email, baseUrl }) {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'BotXchange Credits',
            description: `$${(amountCents / 100).toFixed(2)} in agent execution credits`
          },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `${baseUrl}/app/dashboard?credits=success&amount=${amountCents}`,
      cancel_url: `${baseUrl}/app/dashboard?credits=cancelled`,
      metadata: {
        type: 'founder_credits',
        founderId: founderId,
        amountCents: String(amountCents),
        platform: 'botxchange'
      }
    });

    console.log(`💳 Credit checkout created: $${(amountCents / 100).toFixed(2)} for founder ${founderId}`);
    return { sessionId: session.id, url: session.url };
  }

  /**
   * Handle founder credit purchase webhook
   */
  async handleCreditPayment(session) {
    const founderId = session.metadata.founderId;
    const amountCents = parseInt(session.metadata.amountCents);
    console.log(`💰 Credit payment received: $${(amountCents / 100).toFixed(2)} for founder ${founderId}`);

    const founders = await this.db.query('SELECT credit_balance_cents FROM founders WHERE id = ?', [founderId]);
    if (!founders.length) {
      console.error('Founder not found for credit payment:', founderId);
      return;
    }

    const newBalance = (founders[0].credit_balance_cents || 0) + amountCents;

    await this.db.run(
      'UPDATE founders SET credit_balance_cents = ?, total_credits_purchased_cents = total_credits_purchased_cents + ? WHERE id = ?',
      [newBalance, amountCents, founderId]
    );

    const { v4: uuidv4 } = require('uuid');
    await this.db.run(
      `INSERT INTO credit_transactions (id, founder_id, amount_cents, balance_after_cents, description, transaction_type, stripe_payment_intent, created_at)
       VALUES (?, ?, ?, ?, 'Credit purchase via Stripe', 'purchase', ?, ?)`,
      [uuidv4(), founderId, amountCents, newBalance, session.payment_intent, Date.now()]
    );

    // Reactivate venture if it was paused due to zero credits
    const venture = (await this.db.query('SELECT id, kill_switch_active FROM founder_ventures WHERE founder_id = ?', [founderId]))[0];
    if (venture && venture.kill_switch_active) {
      await this.db.run('UPDATE founder_ventures SET kill_switch_active = 0 WHERE id = ?', [venture.id]);
      await this.db.run(
        `INSERT INTO activity_log (id, venture_id, event_type, message, created_at) VALUES (?, ?, 'credit_reload', ?, ?)`,
        [uuidv4(), venture.id, `Credits loaded: $${(amountCents / 100).toFixed(2)} — activity resumed`, Date.now()]
      );
    }

    console.log(`   ✅ Credits added: $${(amountCents / 100).toFixed(2)}, new balance: $${(newBalance / 100).toFixed(2)}`);
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
        description: 'Bot earnings from BotXchange'
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