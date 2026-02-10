const { v4: uuidv4 } = require('uuid');

/**
 * BOT-TO-BOT COMMUNICATION SYSTEM
 * Bots can message each other, coordinate, and collaborate
 */

class BotCommunication {
  constructor(database) {
    this.db = database;
  }

  /**
   * Bot sends a message to another bot or to a venture channel
   */
  async sendMessage({ fromBotId, toBotId, ventureId, messageType, content }) {
    const messageId = uuidv4();
    
    await this.db.run(`
      INSERT INTO bot_messages (
        id, from_bot_id, to_bot_id, venture_id, message_type, content, timestamp, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'unread')
    `, [messageId, fromBotId, toBotId, ventureId, messageType, JSON.stringify(content), Date.now()]);

    console.log(`💬 Bot ${fromBotId.substring(0, 8)} → ${toBotId ? toBotId.substring(0, 8) : 'venture'}: ${messageType}`);

    return messageId;
  }

  /**
   * Bot requests help from another bot
   */
  async requestHelp({ fromBotId, toBotId, ventureId, taskDescription, skillsNeeded, urgency = 'normal' }) {
    return await this.sendMessage({
      fromBotId,
      toBotId,
      ventureId,
      messageType: 'help_request',
      content: {
        taskDescription,
        skillsNeeded,
        urgency,
        requestedAt: Date.now()
      }
    });
  }

  /**
   * Bot offers to help another bot
   */
  async offerHelp({ fromBotId, toBotId, ventureId, helpWith, estimatedHours }) {
    return await this.sendMessage({
      fromBotId,
      toBotId,
      ventureId,
      messageType: 'help_offer',
      content: {
        helpWith,
        estimatedHours,
        offeredAt: Date.now()
      }
    });
  }

  /**
   * Bot requests code review
   */
  async requestReview({ fromBotId, toBotId, ventureId, fileToReview, concerns }) {
    return await this.sendMessage({
      fromBotId,
      toBotId,
      ventureId,
      messageType: 'review_request',
      content: {
        fileToReview,
        concerns,
        requestedAt: Date.now()
      }
    });
  }

  /**
   * Get all messages for a bot
   */
  async getBotMessages(botId, limit = 50) {
    const messages = await this.db.query(`
      SELECT m.*, 
             b1.name as from_bot_name,
             b2.name as to_bot_name,
             v.title as venture_name
      FROM bot_messages m
      JOIN bots b1 ON m.from_bot_id = b1.id
      LEFT JOIN bots b2 ON m.to_bot_id = b2.id
      LEFT JOIN ventures v ON m.venture_id = v.id
      WHERE m.to_bot_id = ? OR m.from_bot_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `, [botId, botId, limit]);

    return messages.map(m => ({
      ...m,
      content: JSON.parse(m.content)
    }));
  }

  /**
   * Get messages for a venture (group chat)
   */
  async getVentureMessages(ventureId, limit = 100) {
    const messages = await this.db.query(`
      SELECT m.*, 
             b.name as from_bot_name
      FROM bot_messages m
      JOIN bots b ON m.from_bot_id = b.id
      WHERE m.venture_id = ? AND m.to_bot_id IS NULL
      ORDER BY m.timestamp DESC
      LIMIT ?
    `, [ventureId, limit]);

    return messages.map(m => ({
      ...m,
      content: JSON.parse(m.content)
    }));
  }

  /**
   * Mark message as read
   */
  async markAsRead(messageId) {
    await this.db.run(`
      UPDATE bot_messages SET status = 'read' WHERE id = ?
    `, [messageId]);
  }
}

module.exports = BotCommunication;