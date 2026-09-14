export function renderPage(base: string, registration: boolean): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Antarestra · 账号中心</title><link rel="stylesheet" href="${base}/style.css"><script defer src="${base}/app.js"></script></head>
<body data-base="${base}"><main>
<header><a class="brand" href="${base}">✦ ANTARESTRA</a><span>账号与访问权限</span></header>
<div class="intro"><p class="eyebrow">ACCOUNT CENTER</p><h1>从你的账号开始。</h1><p>登录 Antarestra，管理你的身份与访问权限。</p></div>
<p id="message" role="status" aria-live="polite" hidden></p>
<section id="guest" class="card"><nav aria-label="认证方式"><button id="show-login" class="selected">登录</button>${registration ? '<button id="show-register">创建账号</button>' : ''}</nav>
<form id="login"><h2>欢迎回来</h2><label>邮箱<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>密码<input name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128"></label><button class="primary">登录</button></form>
${registration ? '<form id="register" hidden><h2>创建你的账号</h2><label>显示名称<input name="displayName" autocomplete="nickname" required maxlength="128"></label><label>邮箱<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>密码<input name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="128"></label><p class="hint">使用 12 到 128 个字符。邮箱作为登录名使用。</p><button class="primary">创建账号</button></form>' : ''}</section>
<section id="account" class="card" hidden><div class="row"><h2 id="welcome">当前账号</h2><button id="logout">退出登录</button></div><p id="principal"></p><p class="hint">访问权限由管理员分配，注册账号不会自动取得管理权限。</p></section>
<section id="users-panel" class="card wide" hidden><div class="row"><h2>本地用户</h2><button id="refresh-users">刷新</button></div><div id="users"></div><div class="row"><button id="previous">上一页</button><span id="page-number"></span><button id="next">下一页</button></div></section>
<section id="roles-panel" class="card wide" hidden><h2>角色与权限</h2><p id="permissions" class="hint"></p><div id="roles"></div><form id="role-form"><h3>创建或更新角色</h3><div class="grid"><label>角色标识<input name="id" required maxlength="128" placeholder="例如 operator"></label><label>角色名称<input name="name" required maxlength="128" placeholder="例如 运营人员"></label></div><label>权限标识（英文逗号分隔）<input name="permissions" placeholder="identity.local.manage"></label><button class="primary">保存角色</button></form></section>
<section id="bindings-panel" class="card wide" hidden><h2>分配角色</h2><form id="binding-form"><label>主体标识<input name="principalId" required maxlength="128" placeholder="从用户卡片选择或粘贴主体标识"></label><div class="grid"><label>角色标识<input name="roleId" required maxlength="128"></label><label>授权范围<input name="scope" value="system" required maxlength="128"></label></div><p class="hint">system 用于系统管理；空间权限必须绑定到准确的空间标识。</p><div class="row"><button class="primary" name="action" value="grant">授予角色</button><button name="action" value="revoke">撤销手动绑定</button><button id="load-bindings" type="button">查看绑定</button></div></form><pre id="bindings"></pre></section>
<footer>ANTARESTRA <span>每个身份，清晰的访问边界。</span></footer>
</main></body></html>`
}

export const pageStyle = `
:root{font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#243237;background:#f3f5f2;font-synthesis:none;color-scheme:light}
*{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:auto;padding:32px 40px 24px}header,footer,.row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}header{padding-bottom:22px;border-bottom:1px solid #d8dfd9;font-size:13px;color:#63716a}.brand{font-weight:750;letter-spacing:2px;color:#203e33;text-decoration:none}.intro{margin:52px 0 32px}.eyebrow{font-size:11px;letter-spacing:3px;color:#467660;font-weight:700}h1{font-size:36px;letter-spacing:-1px;margin:12px 0 16px}p{line-height:1.7}.intro>p:last-child{color:#66736c}h2{font-size:21px;margin:0 0 20px}h3{font-size:16px}.card{max-width:480px;background:#fff;border:1px solid #dae1da;border-radius:14px;padding:28px;margin-bottom:24px;box-shadow:0 8px 30px #263e3105}.wide{max-width:none}nav{display:flex;gap:8px;margin-bottom:28px;border-bottom:1px solid #e1e6e0;padding-bottom:14px}button,input{font:inherit}button{border:1px solid #ccd5cd;border-radius:7px;padding:10px 16px;background:white;color:#294437;cursor:pointer;font-size:14px}button:hover{background:#eff4ef}button:disabled{opacity:.55;cursor:wait}button.primary,nav .selected{background:#264f3d;border-color:#264f3d;color:white}.primary:hover{background:#173c2b}label{display:block;font-size:14px;font-weight:600;margin:0 0 18px}input{display:block;width:100%;padding:12px;border:1px solid #cbd5ce;border-radius:7px;margin-top:8px;background:#fcfdfb;color:#243237}input:focus,button:focus-visible{outline:2px solid #538768;outline-offset:2px}form>.primary{width:100%;margin-top:6px}.hint{font-size:13px;color:#68786e;overflow-wrap:anywhere}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.user{padding:20px 0;border-bottom:1px solid #e5e9e3}.user p{margin:6px 0;overflow-wrap:anywhere}.user .row{justify-content:flex-start}.role{padding:14px 0;border-bottom:1px solid #e5e9e3;overflow-wrap:anywhere}#message{border-left:3px solid #508064;padding:12px 16px;background:#e6eee5;border-radius:4px}#principal,pre{font-size:13px;overflow-wrap:anywhere;white-space:pre-wrap}footer{font-size:11px;letter-spacing:1px;color:#6d7971;border-top:1px solid #d8dfd9;margin-top:48px;padding-top:20px}footer span{letter-spacing:0}[hidden]{display:none!important}@media(max-width:600px){main{padding:22px 18px}.intro{margin:34px 0 24px}h1{font-size:29px}.card{padding:22px;max-width:none}.grid{grid-template-columns:1fr;gap:0}header{gap:10px}footer{align-items:flex-start;flex-direction:column}.row{gap:10px}}
`

export const pageScript = String.raw`
'use strict'
const base = document.body.dataset.base
const el = (id) => document.getElementById(id)
let offset = 0
let actorId = ''
const message = (text) => { el('message').textContent = text; el('message').hidden = false }
async function api(path, body, method = 'POST') {
  const response = await fetch('/api' + path, body === undefined ? { credentials: 'same-origin' } : { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.status = response.status; throw error }
  return data
}
function bindForm(id, callback) {
  const form = el(id)
  if (!form) return
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form))
    const buttons = [...form.querySelectorAll('button')]
    buttons.forEach(button => button.disabled = true)
    try { await callback(values, event.submitter?.value) } catch (error) { message(error.message) }
    finally { buttons.forEach(button => button.disabled = false) }
  })
}
function showForm(register) {
  el('login').hidden = register
  if (el('register')) el('register').hidden = !register
  el('show-login').classList.toggle('selected', !register)
  el('show-register')?.classList.toggle('selected', register)
}
el('show-login').onclick = () => showForm(false)
if (el('show-register')) el('show-register').onclick = () => showForm(true)
bindForm('login', async (values) => { await api(base + '/login', values); el('login').reset(); message('登录成功'); await refresh() })
bindForm('register', async (values) => { await api(base + '/register', values); el('register').reset(); showForm(false); message('账号创建成功，请登录。') })
el('logout').onclick = async () => { try { await api('/auth/logout', {}); message('已退出登录'); await refresh() } catch (error) { message(error.message) } }
function node(tag, text, className) { const item = document.createElement(tag); item.textContent = text; if (className) item.className = className; return item }
async function users() {
  const rows = await api(base + '/users?offset=' + offset)
  el('users-panel').hidden = false
  el('users').replaceChildren()
  for (const row of rows) {
    const item = node('div', '', 'user')
    item.append(node('strong', row.principal?.display_name || row.email), node('p', row.email), node('p', '主体：' + row.principal_id, 'hint'), node('p', row.principal?.status === 'active' ? '正常' : '已禁用', 'hint'))
    const actions = node('div', '', 'row')
    const select = node('button', '配置角色')
    select.onclick = () => { el('bindings-panel').hidden = false; el('binding-form').elements.principalId.value = row.principal_id; el('bindings-panel').scrollIntoView({ behavior: 'smooth' }) }
    actions.append(select)
    if (row.principal_id !== actorId) {
      const toggle = node('button', row.principal?.status === 'active' ? '禁用账号' : '启用账号')
      toggle.onclick = async () => { try { await api(base + '/users/' + encodeURIComponent(row.id) + '/status', { status: row.principal?.status === 'active' ? 'disabled' : 'active' }, 'PUT'); message('账号状态已更新'); await users() } catch (error) { message(error.message) } }
      actions.append(toggle)
    }
    item.append(actions); el('users').append(item)
  }
  if (!rows.length) el('users').append(node('p', '暂无用户'))
  el('previous').disabled = offset === 0
  el('next').disabled = rows.length < 50
  el('page-number').textContent = '第 ' + (offset / 50 + 1) + ' 页'
}
async function roles() {
  const data = await api('/rbac/roles')
  el('roles-panel').hidden = false
  el('permissions').textContent = '已声明权限：' + data.permissions.map(p => p.key).join('、')
  el('roles').replaceChildren()
  for (const role of data.roles) el('roles').append(node('div', role.name + ' (' + role.id + ')：' + data.grants.filter(g => g.role_id === role.id).map(g => g.permission).join('、'), 'role'))
}
async function refresh() {
  for (const id of ['account', 'users-panel', 'roles-panel', 'bindings-panel']) el(id).hidden = true
  try {
    const data = await api('/auth/me')
    actorId = data.auth.principalId
    el('guest').hidden = true; el('account').hidden = false
    el('welcome').textContent = data.principal.display_name
    el('principal').textContent = '主体：' + actorId
    for (const load of [users, roles]) { try { await load() } catch (error) { if (error.status !== 403) message(error.message) } }
    try { await api('/rbac/bindings/' + encodeURIComponent(actorId)); el('bindings-panel').hidden = false } catch (error) { if (error.status !== 403) message(error.message) }
  } catch (error) { el('guest').hidden = false; if (error.status !== 401) message(error.message) }
}
bindForm('role-form', async (values) => { await api('/rbac/roles/' + encodeURIComponent(values.id), { name: values.name, permissions: values.permissions.split(',').map(p => p.trim()).filter(Boolean) }, 'PUT'); message('角色已保存'); await roles() })
bindForm('binding-form', async (values, action) => { await api('/rbac/bindings/' + encodeURIComponent(values.principalId), { roleId: values.roleId, scope: values.scope, enabled: action === 'grant' }, 'PUT'); message('角色绑定已更新'); await bindings() })
async function bindings() { const id = el('binding-form').elements.principalId.value; if (!id) throw new Error('请先填写主体标识'); const rows = await api('/rbac/bindings/' + encodeURIComponent(id)); el('bindings').textContent = rows.length ? rows.map(row => '角色：' + row.role_id + '\n范围：' + row.scope + '\n来源：' + row.source + '\n有效期：' + (row.expires_at ? new Date(row.expires_at).toLocaleString() : '长期')).join('\n\n') : '暂无角色绑定' }
el('load-bindings').onclick = () => bindings().catch(error => message(error.message))
el('refresh-users').onclick = () => users().catch(error => message(error.message))
el('previous').onclick = () => { offset = Math.max(0, offset - 50); users().catch(error => message(error.message)) }
el('next').onclick = () => { offset += 50; users().catch(error => message(error.message)) }
refresh().catch(error => message(error.message))
`
