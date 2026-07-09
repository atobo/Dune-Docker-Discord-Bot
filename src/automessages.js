const fs = require('fs');
const path = require('path');
const rabbitmq = require('./rabbitmq');

const DB_FILE = path.join(__dirname, '..', 'automessages.json');

class AutoMessages {
  constructor() {
    this.messages = [];
    this.intervals = {};
  }

  init() {
    this.loadMessages();
  }

  loadMessages() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        this.messages = JSON.parse(data);
        console.log(`Loaded ${this.messages.length} automessages from disk.`);
        this.startAll();
      } catch (err) {
        console.error('Failed to load automessages.json:', err);
      }
    }
  }

  saveMessages() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.messages, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save automessages.json:', err);
    }
  }

  startAll() {
    this.messages.forEach(msg => this.scheduleMessage(msg));
  }

  scheduleMessage(msg) {
    if (this.intervals[msg.id]) {
      clearInterval(this.intervals[msg.id]);
    }
    
    // interval is in minutes, convert to milliseconds
    const ms = msg.interval * 60 * 1000;
    this.intervals[msg.id] = setInterval(() => {
      console.log(`[AutoMessage] Broadcasting: ${msg.text}`);
      rabbitmq.sendServerCommand('announce', [msg.text]).catch(err => {
        console.error(`[AutoMessage] Failed to broadcast: ${err.message}`);
      });
    }, ms);
  }

  addMessage(interval, text) {
    const id = Date.now().toString();
    const newMsg = { id, interval, text };
    this.messages.push(newMsg);
    this.saveMessages();
    this.scheduleMessage(newMsg);
    return newMsg;
  }

  removeMessage(id) {
    const initialLength = this.messages.length;
    this.messages = this.messages.filter(m => m.id !== id);
    if (this.messages.length < initialLength) {
      if (this.intervals[id]) {
        clearInterval(this.intervals[id]);
        delete this.intervals[id];
      }
      this.saveMessages();
      return true;
    }
    return false;
  }

  getMessages() {
    return this.messages;
  }
}

module.exports = new AutoMessages();
