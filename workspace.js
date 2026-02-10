const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

/**
 * WORKSPACE SYSTEM
 * Where bots collaborate, complete tasks, and track work
 */

class WorkspaceManager {
  constructor(database) {
    this.db = database;
    this.WORKSPACE_ROOT = './workspaces';
  }

  async initialize() {
    // Create workspaces directory
    try {
      await fs.mkdir(this.WORKSPACE_ROOT, { recursive: true });
    } catch (err) {
      console.log('Workspaces directory already exists');
    }
  }

  /**
   * Create workspace for a venture
   */
  async createWorkspace(ventureId) {
    const workspaceId = uuidv4();
    const workspacePath = path.join(this.WORKSPACE_ROOT, ventureId);

    // Create directory structure
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.mkdir(path.join(workspacePath, 'files'), { recursive: true });
    await fs.mkdir(path.join(workspacePath, 'code'), { recursive: true });
    await fs.mkdir(path.join(workspacePath, 'docs'), { recursive: true });

    // Create workspace in database
    await this.db.run(`
      INSERT INTO workspaces (id, venture_id, created_at)
      VALUES (?, ?, ?)
    `, [workspaceId, ventureId, Date.now()]);

    console.log(`📁 Workspace created for venture ${ventureId}`);
    return workspaceId;
  }

  /**
   * Create a task in the workspace
   */
  async createTask({ ventureId, title, description, estimatedHours, assignedTo }) {
    const taskId = uuidv4();

    await this.db.run(`
      INSERT INTO workspace_tasks (
        id, venture_id, title, description, estimated_hours,
        assigned_to, status, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'todo', ?)
    `, [taskId, ventureId, title, description, estimatedHours, assignedTo, Date.now()]);

    console.log(`✅ Task created: ${title}`);
    return taskId;
  }

  /**
   * Bot starts working on a task
   */
  async startTask({ taskId, botId }) {
    await this.db.run(`
      UPDATE workspace_tasks
      SET status = 'in_progress',
          assigned_to = ?,
          started_at = ?
      WHERE id = ?
    `, [botId, Date.now(), taskId]);

    console.log(`🚀 Bot ${botId} started task ${taskId}`);
  }

  /**
   * Bot completes a task (automatically logs hours!)
   */
  async completeTask({ taskId, botId, deliverable }) {
    const task = await this.db.query(
      'SELECT * FROM workspace_tasks WHERE id = ?',
      [taskId]
    );

    if (task.length === 0) {
      throw new Error('Task not found');
    }

    const taskData = task[0];
    const hoursWorked = taskData.estimated_hours || 1;

    // Mark task as done
    await this.db.run(`
      UPDATE workspace_tasks
      SET status = 'done',
          completed_at = ?,
          actual_hours = ?,
          deliverable = ?
      WHERE id = ?
    `, [Date.now(), hoursWorked, deliverable, taskId]);

    // AUTOMATICALLY LOG WORK HOURS (This is the key!)
    await this.db.run(`
      INSERT INTO tasks (
        id, venture_id, bot_id, hours_spent, description, impact_score, completed_at
      )
      VALUES (?, ?, ?, ?, ?, 1.0, ?)
    `, [uuidv4(), taskData.venture_id, botId, hoursWorked, taskData.title, Date.now()]);

    // Update bot's total hours
    await this.db.run(`
      UPDATE venture_participants
      SET hours_worked = hours_worked + ?
      WHERE venture_id = ? AND bot_id = ?
    `, [hoursWorked, taskData.venture_id, botId]);

    console.log(`✅ Task completed: ${taskData.title}`);
    console.log(`   Hours logged: ${hoursWorked}`);
    console.log(`   Equity will recalculate automatically`);

    // Trigger equity recalculation
    const ExchangeProtocol = require('./protocol').ExchangeProtocol;
    const protocol = new ExchangeProtocol(this.db);
    await protocol.recalculateEquity(taskData.venture_id);

    return { hoursWorked, taskData };
  }

/**
   * Upload file to workspace
   */
  async uploadFile({ ventureId, fileName, content, uploadedBy }) {
    const fileId = uuidv4();
    const workspacePath = path.join(this.WORKSPACE_ROOT, ventureId, 'files');
    const filePath = path.join(workspacePath, fileName);

    // CREATE DIRECTORY IF IT DOESN'T EXIST
    await fs.mkdir(workspacePath, { recursive: true });

    // Write file
    await fs.writeFile(filePath, content);

    // Log in database
    await this.db.run(`
      INSERT INTO workspace_files (
        id, venture_id, file_name, file_path, uploaded_by, uploaded_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `, [fileId, ventureId, fileName, filePath, uploadedBy, Date.now()]);

    console.log(`📄 File uploaded: ${fileName}`);
    return fileId;
  }

  /**
   * Get all tasks for a venture
   */
  async getTasks(ventureId) {
    const tasks = await this.db.query(`
      SELECT t.*, b.name as assigned_to_name
      FROM workspace_tasks t
      LEFT JOIN bots b ON t.assigned_to = b.id
      WHERE t.venture_id = ?
      ORDER BY t.created_at DESC
    `, [ventureId]);

    return tasks;
  }

  /**
   * Get workspace activity feed
   */
  async getActivity(ventureId, limit = 20) {
    const activities = await this.db.query(`
      SELECT 
        'task_completed' as type,
        t.title as description,
        b.name as bot_name,
        t.completed_at as timestamp
      FROM workspace_tasks t
      JOIN bots b ON t.assigned_to = b.id
      WHERE t.venture_id = ? AND t.status = 'done'
      
      UNION ALL
      
      SELECT
        'file_uploaded' as type,
        f.file_name as description,
        b.name as bot_name,
        f.uploaded_at as timestamp
      FROM workspace_files f
      JOIN bots b ON f.uploaded_by = b.id
      WHERE f.venture_id = ?
      
      ORDER BY timestamp DESC
      LIMIT ?
    `, [ventureId, ventureId, limit]);

    return activities;
  }
}

module.exports = WorkspaceManager;
