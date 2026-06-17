require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_API_KEY || !DISCORD_WEBHOOK || !DATABASE_ID) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

// Discord User IDs
const DISCORD_IDS = {
  'มอส': '427444934140755969',
  'คิตตี้': '791544250412171324',
  'กาย': '861501214054547456',
  'คีน': '358803055216558097',
  'ท่านท็อป': '457413396510408716',
  'วีไวท์': '971033177214820383',
  'มังกร': '531064854048669696'
};

// Status ที่ต้องแจ้งเตือน
const ACTIVE_STATUSES = ['Not started', 'In progress', 'Done'];

// Thai status labels
const STATUS_LABELS = {
  'Not started': '🆕 งานใหม่จ้าา',
  'In progress': '⚙️ กำลังทำคว้าฟ',
  'Done': '✅ เสร็จแล้วงับบ',
  'Backlog': '📦 Backlog'
};

const DATA_FILE = path.join(__dirname, 'bot_data.json');

let previousData = {};

function loadPreviousData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      previousData = JSON.parse(data);
      console.log('📂 Loaded previous data from file');
    }
  } catch (error) {
    console.error('⚠️ Could not load previous data:', error.message);
    previousData = {};
  }
}

function savePreviousData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(previousData, null, 2));
  } catch (error) {
    console.error('⚠️ Could not save data:', error.message);
  }
}

async function getNotionData() {
  try {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28'
        }
      }
    );
    return response.data.results;
  } catch (error) {
    console.error('❌ Error fetching Notion:', error.message);
    return [];
  }
}

function getPropertyValue(properties, fieldName) {
  const prop = properties[fieldName];
  if (!prop) return '';

  switch (prop.type) {
    case 'title':
      return prop.title[0]?.plain_text || '';
    case 'rich_text':
      return prop.rich_text[0]?.plain_text || '';
    case 'select':
      return prop.select?.name || '';
    case 'status':
      return prop.status?.name || '';
    case 'multi_select':
      return prop.multi_select.map(s => s.name).join(', ') || '';
    case 'date':
      return prop.date?.start || '';
    case 'people':
      return prop.people.map(p => p.name).join(', ') || '';
    case 'formula':
      if (prop.formula.type === 'string') {
        return prop.formula.string || '';
      }

      if (prop.formula.type === 'number') {
        return prop.formula.number ?? 0;
      }

      if (prop.formula.type === 'boolean') {
        return prop.formula.boolean;
      }

      return '';
    case 'checkbox':
      return prop.checkbox ? 'true' : 'false';
    case 'rollup':
      return '';
    default:
      return '';
  }
}

function getTaskTitle(page) {
  const title = page.properties['Task name'];
  if (title && title.title && title.title[0]) {
    return title.title[0].plain_text;
  }
  return 'Untitled';
}

// ✅ ส่งกลับ Discord mentions (tags) โดยไม่มี @channel
function getMentionTags(assigneeText) {
  if (!assigneeText) return '';
  
  const names = assigneeText.split(',').map(n => n.trim());
  let mentions = [];
  
  names.forEach(name => {
    if (DISCORD_IDS[name]) {
      mentions.push(`<@${DISCORD_IDS[name]}>`);
    }
  });
  
  return mentions.length > 0 ? mentions.join(' ') : '';
}

function getSubTasksPercentage(properties) {
  const checkedSubTasks = getPropertyValue(properties, 'Checked Sub Tasks');
  const allSubTasks = getPropertyValue(properties, 'All Sub Tasks');
  
  let checked = checkedSubTasks;
  let all = allSubTasks;
  
  if (!checked) {
    checked = getPropertyValue(properties, 'Formula-CheckedSubTasks');
  }
  if (!all) {
    all = getPropertyValue(properties, 'Formula-AllSubTasks');
  }
  
  if (checked && all && !isNaN(checked) && !isNaN(all)) {
    const checkNum = parseInt(checked);
    const allNum = parseInt(all);
    if (allNum > 0) {
      const percentage = Math.round((checkNum / allNum) * 100);
      return { checked: checkNum, all: allNum, percentage };
    }
  }
  
  return null;
}

function getSubTaskProgressBar(checked, all) {
  if (!all || all <= 0) return '';

  const percentage = checked / all;
  const filled = Math.round(percentage * 10);
  const empty = 10 - filled;

  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatDate(dateString) {
  if (!dateString) return 'ไม่มี';
  const date = new Date(dateString);
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString('th-TH', options);
}

function getStatusColor(status) {
  const colors = {
    'Done': 0x51CF66,
    'In progress': 0xFFA500,
    'Not started': 0xFF6B6B,
    'Backlog': 0x808080,
    'default': 0x808080
  };
  return colors[status] || colors['default'];
}

function getNotionPageUrl(pageId) {
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

function formatDueDate(dateString) {
  if (!dateString) return 'ไม่มี';

  const now = new Date();
  const dueDate = new Date(dateString);

  const diffTime = dueDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  let status = '';

  if (diffDays > 0) {
    status = `⏳ เหลือ ${diffDays} วัน`;
  } else if (diffDays === 0) {
    status = '🔥 วันนี้';
  } else {
    status = `🚨 เกิน ${Math.abs(diffDays)} วัน`;
  }

  return `${formatDate(dateString)} • ${status}`;
}

function getPriorityLabel(priority) {
  switch(priority?.toLowerCase()) {
    case 'high':
      return '🔴 High';
    case 'medium':
      return '🟡 Medium';
    case 'low':
      return '🟢 Low';
    default:
      return '⚪ None';
  }
}

// ✅ แก้ไข: ลบ content (ไม่แสดง tag ด้านบน), ตกแต่ง status
async function sendDiscordMessage(taskName, status, priority, projects, sprint, assignee, role, dueDate, pageUrl, changeType, subTaskStats) {
  try {
    console.log(`🚀 Sending: ${taskName}`);
    const mentions = getMentionTags(assignee);
    const statusLabel = STATUS_LABELS[status] || status;
    const progressBar = subTaskStats ? getSubTaskProgressBar(subTaskStats.percentage) : '';

    // สร้าง fields array
    const fields = [
      {
        name: '**Status**',
        value: `\`${status}\``,
        inline: false
      },
      {
        name: '**Priority**',
        value: `\`${getPriorityLabel(priority)}\``,
        inline: true
      },
      {
        name: '**Projects**',
        value: `\`${projects || 'ไม่มี'}\``,
        inline: true
      },
      {
        name: '**Sprint**',
        value: `\`${sprint || 'ไม่มี'}\``,
        inline: true
      },
      {
        name: '**Assign to**',
        value: mentions || 'ไม่มี',
        inline: true
      },
      {
        name: '**Role**',
        value: `\`${role || 'ไม่มี'}\``,
        inline: true
      },
      {
        name: '**Due Date**',
        value:
          `\`${formatDueDate(dueDate)}\``,
        inline: true
      }
    ];

    // เพิ่ม Sub Tasks field ถ้ามี
    if (subTaskStats) {
      const progressBar = getSubTaskProgressBar(
        subTaskStats.checked,
        subTaskStats.all
      );

      fields.push({
        name: '📋 Tasks',
        value: `${progressBar} ${subTaskStats.checked}/${subTaskStats.all} tasks completed`,
        inline: false
      });
    }

    const message = {
      embeds: [{
        title: `【 ${statusLabel} 】 ${taskName}`,
        fields: fields,
        color: getStatusColor(status),
        footer: {
          text: `${changeType} • ${new Date().toLocaleString('th-TH')}`
        },
        url: pageUrl
      }]
    };

    const response = await axios.post(DISCORD_WEBHOOK, message);
    console.log(`✅ Sent: ${taskName} - ${changeType}`);
    return true;
  } catch (error) {
    console.error('❌ Error sending to Discord:', error.message);
    console.error('   Full error:', error.response?.data || error);
    return false;
  }
}

async function checkForChanges() {
  const pages = await getNotionData();

  if (pages.length === 0) {
    console.log(`⏰ ${new Date().toLocaleTimeString('th-TH')} - No tasks found`);
    return;
  }

  console.log(`🔍 ${new Date().toLocaleTimeString('th-TH')} - Found ${pages.length} tasks`);

  pages.forEach(page => {
    const pageId = page.id;
    const properties = page.properties;

    const taskName = getTaskTitle(page);
    const status = getPropertyValue(properties, 'Status');
    const priority = getPropertyValue(properties, 'Formula-Priority');
    const projects = getPropertyValue(properties, 'Formula-Projects');
    const sprint = getPropertyValue(properties, 'Formula-Sprint');
    
    const assignee = getPropertyValue(properties, 'Formula-Assign')
    
    const role = getPropertyValue(properties, 'Formula-Role');
    
    // ✅ ลองหา due date จากหลาย field
    let dueDate = getPropertyValue(properties, 'Due date');
    if (!dueDate) {
      dueDate = getPropertyValue(properties, 'Due Date');
    }
    if (!dueDate) {
      dueDate = getPropertyValue(properties, 'Formula-Date');
    }
    if (!dueDate) {
      dueDate = getPropertyValue(properties, 'Display-Date');
    }
    
    const pageUrl = getNotionPageUrl(pageId);
    
    const subTaskStats = getSubTasksPercentage(properties);

    const currentData = {
      status,
      priority,
      projects,
      sprint,
      assignee,
      role,
      dueDate,
      subTaskStats: subTaskStats ? { checked: subTaskStats.checked, all: subTaskStats.all, percentage: subTaskStats.percentage } : null
    };

    if (!ACTIVE_STATUSES.includes(status)) {
      if (previousData[pageId]) {
        delete previousData[pageId];
        savePreviousData();
      }
      return;
    }

    if (!previousData[pageId]) {
      // ✅ Task เข้ามา (จาก Backlog หรือเป็นใหม่)
      previousData[pageId] = currentData;
      savePreviousData();
      console.log(`  🟢 Now tracking: ${taskName} (${status})`);
      
      // ✅ ส่ง notification ตอน task เข้ามาจาก Backlog
      sendDiscordMessage(taskName, status, priority, projects, sprint, assignee, role, dueDate, pageUrl, 'Backlog → Active', subTaskStats);
      return;
    }

    const prevData = previousData[pageId];

    let hasChanged = false;
    let changeType = '';

    // ✅ แจ้งเตือนเฉพาะตอนเปลี่ยนสถานะ
    if (prevData.status !== status) {
      hasChanged = true;
      changeType = `Status: ${prevData.status} → ${status}`;
    }
    // ✅ หรือ sub tasks เปลี่ยน
    else if (subTaskStats && prevData.subTaskStats && 
             prevData.subTaskStats.percentage !== subTaskStats.percentage) {
      hasChanged = true;
      changeType = `Sub Tasks: ${prevData.subTaskStats.percentage}% → ${subTaskStats.percentage}%`;
    }

    // ✅ อัพเดท data ตลอดเวลา (ไม่ว่าจะมี change หรือไม่)
    if (prevData.priority !== priority || 
        prevData.projects !== projects || 
        prevData.sprint !== sprint || 
        prevData.assignee !== assignee || 
        prevData.role !== role || 
        prevData.dueDate !== dueDate) {
      // อัพเดทแต่ไม่แจ้งเตือน
      previousData[pageId] = currentData;
      savePreviousData();
    }

    // เฉพาะส่ง notification ถ้า status หรือ sub tasks เปลี่ยน
    if (hasChanged) {
      console.log(`  🔄 Change detected: ${taskName} - ${changeType}`);
      console.log(`     Old status: "${prevData.status}"`);
      console.log(`     New status: "${status}"`);
      sendDiscordMessage(taskName, status, priority, projects, sprint, assignee, role, dueDate, pageUrl, changeType, subTaskStats);
      previousData[pageId] = currentData;
      savePreviousData();
    }
  });
}

loadPreviousData();

setInterval(() => {
  checkForChanges();
}, 5000);

console.log('🤖 Bot started!');
console.log('⏰ Checking every 5 seconds');
console.log('📌 Active statuses:', ACTIVE_STATUSES.join(', '));
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  savePreviousData();
  process.exit(0);
});
