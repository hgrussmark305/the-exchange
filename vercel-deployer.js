const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * VERCEL DEPLOYMENT SYSTEM
 * Bots can deploy their work to production
 */

class VercelDeployer {
  constructor(workspaceManager, db) {
    this.workspace = workspaceManager;
    this.db = db;
  }

  /**
   * Deploy a venture's workspace to Vercel
   */
  async deployVenture({ ventureId, botId }) {
    console.log(`\n🚀 Bot deploying venture ${ventureId} to Vercel...`);

    const workspacePath = path.join(__dirname, 'workspaces', ventureId);
    
    // Check if workspace has deployable files
    const hasDeployableContent = this.checkDeployableContent(workspacePath);
    
    if (!hasDeployableContent) {
      throw new Error('No deployable content found. Need HTML, React, or Next.js files.');
    }

    // Create deployment package
    const deploymentPath = await this.createDeploymentPackage(workspacePath, ventureId);

    // Get venture info for deployment name
    const ventures = await this.db.query('SELECT title FROM ventures WHERE id = ?', [ventureId]);
    const projectName = this.sanitizeProjectName(ventures[0].title);

    try {
      // Deploy to Vercel (requires Vercel CLI and auth)
      const deploymentUrl = await this.deployToVercel(deploymentPath, projectName);

      // Record deployment
      await this.recordDeployment({
        ventureId,
        botId,
        url: deploymentUrl,
        platform: 'vercel'
      });

      console.log(`✅ Deployed successfully!`);
      console.log(`🌐 Live URL: ${deploymentUrl}`);

      return {
        success: true,
        url: deploymentUrl,
        platform: 'vercel'
      };
    } catch (error) {
      console.error('❌ Deployment failed:', error.message);
      throw error;
    }
  }

  /**
   * Check if workspace has deployable files
   */
  checkDeployableContent(workspacePath) {
    const filesPath = path.join(workspacePath, 'files');
    
    if (!fs.existsSync(filesPath)) {
      return false;
    }

    const files = fs.readdirSync(filesPath);
    
    // Check for web files
    const hasHTML = files.some(f => f.endsWith('.html'));
    const hasReact = files.some(f => f.endsWith('.jsx') || f.endsWith('.tsx'));
    const hasPackageJson = files.some(f => f === 'package.json');
    
    return hasHTML || hasReact || hasPackageJson;
  }

  /**
   * Create deployment package with proper structure
   */
  async createDeploymentPackage(workspacePath, ventureId) {
    const deployPath = path.join(__dirname, 'deployments', ventureId);
    
    // Create deployment directory
    if (!fs.existsSync(deployPath)) {
      fs.mkdirSync(deployPath, { recursive: true });
    }

    const filesPath = path.join(workspacePath, 'files');
    const files = fs.readdirSync(filesPath);

    // Determine project type and create appropriate structure
    const hasReact = files.some(f => f.endsWith('.jsx'));
    const hasHTML = files.some(f => f.endsWith('.html'));

    if (hasReact) {
      // Create React/Vite project structure
      await this.createReactProject(deployPath, filesPath, files);
    } else if (hasHTML) {
      // Simple static site
      await this.createStaticSite(deployPath, filesPath, files);
    }

    return deployPath;
  }

  /**
   * Create React project structure for deployment
   */
  async createReactProject(deployPath, sourcePath, files) {
    // Create package.json
    const packageJson = {
      name: "bot-venture-app",
      version: "1.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        preview: "vite preview"
      },
      dependencies: {
        react: "^18.2.0",
        "react-dom": "^18.2.0"
      },
      devDependencies: {
        "@vitejs/plugin-react": "^4.2.0",
        vite: "^5.0.0"
      }
    };

    fs.writeFileSync(
      path.join(deployPath, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // Create vite.config.js
    const viteConfig = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})`;

    fs.writeFileSync(path.join(deployPath, 'vite.config.js'), viteConfig);

    // Create index.html
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bot-Built App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`;

    fs.writeFileSync(path.join(deployPath, 'index.html'), indexHtml);

    // Create src directory
    const srcPath = path.join(deployPath, 'src');
    if (!fs.existsSync(srcPath)) {
      fs.mkdirSync(srcPath);
    }

    // Copy React components
    files.forEach(file => {
      if (file.endsWith('.jsx')) {
        const content = fs.readFileSync(path.join(sourcePath, file), 'utf8');
        fs.writeFileSync(path.join(srcPath, file), content);
      }
    });

    // Create main.jsx
    const mainJsx = `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`;

    fs.writeFileSync(path.join(srcPath, 'main.jsx'), mainJsx);
  }

  /**
   * Create static site structure
   */
  async createStaticSite(deployPath, sourcePath, files) {
    // Copy all files
    files.forEach(file => {
      const content = fs.readFileSync(path.join(sourcePath, file), 'utf8');
      fs.writeFileSync(path.join(deployPath, file), content);
    });

    // Create vercel.json for static hosting
    const vercelConfig = {
      "cleanUrls": true,
      "trailingSlash": false
    };

    fs.writeFileSync(
      path.join(deployPath, 'vercel.json'),
      JSON.stringify(vercelConfig, null, 2)
    );
  }

  /**
   * Deploy to Vercel using CLI
   */
  async deployToVercel(deployPath, projectName) {
    try {
      // Deploy using Vercel CLI
      // Note: Requires VERCEL_TOKEN environment variable
      const output = execSync(
        `cd ${deployPath} && vercel --prod --yes --token=${process.env.VERCEL_TOKEN} --name=${projectName}`,
        { encoding: 'utf8' }
      );

      // Extract URL from output
      const urlMatch = output.match(/https:\/\/[^\s]+/);
      if (urlMatch) {
        return urlMatch[0];
      }

      throw new Error('Could not extract deployment URL');
    } catch (error) {
      throw new Error(`Vercel deployment failed: ${error.message}`);
    }
  }

  /**
   * Record deployment in database
   */
  async recordDeployment({ ventureId, botId, url, platform }) {
    const { v4: uuidv4 } = require('uuid');
    
    await this.db.run(`
      INSERT INTO deployments (
        id, venture_id, bot_id, url, platform, deployed_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [uuidv4(), ventureId, botId, url, platform, Date.now()]);

    // Update venture with live URL
    await this.db.run(`
      UPDATE ventures 
      SET live_url = ?, status = 'active'
      WHERE id = ?
    `, [url, ventureId]);
  }

  /**
   * Sanitize project name for Vercel
   */
  sanitizeProjectName(title) {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
  }
}

module.exports = VercelDeployer;