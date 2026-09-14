export function mountAccount(root, base, signal) {
  const el = (id) => root.querySelector('#' + id)
  let offset = 0
  let actorId = ''
  const message = (text) => {
    if (signal.aborted) return
    el('message').textContent = text
    el('message').hidden = false
  }
  async function api(path, body, method = 'POST') {
    const response = await fetch(
      '/api' + path,
      body === undefined
        ? { credentials: 'same-origin', signal }
        : {
            method,
            signal,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
    )
    const data = await response.json()
    if (!response.ok) {
      const error = new Error(data.error || '请求失败')
      error.status = response.status
      throw error
    }
    return data
  }
  function bindForm(id, callback) {
    const form = el(id)
    if (!form) return
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const values = Object.fromEntries(new FormData(form))
      const buttons = [...form.querySelectorAll('button')]
      buttons.forEach((button) => (button.disabled = true))
      try {
        await callback(values, event.submitter?.value)
      } catch (error) {
        message(error.message)
      } finally {
        buttons.forEach((button) => (button.disabled = false))
      }
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
  bindForm('login', async (values) => {
    await api(base + '/login', values)
    el('login').reset()
    message('登录成功')
    await refresh()
  })
  bindForm('register', async (values) => {
    await api(base + '/register', values)
    el('register').reset()
    showForm(false)
    message('账号创建成功，请登录。')
  })
  el('logout').onclick = async () => {
    try {
      await api('/auth/logout', {})
      message('已退出登录')
      await refresh()
    } catch (error) {
      message(error.message)
    }
  }
  function node(tag, text, className) {
    const item = document.createElement(tag)
    item.textContent = text
    if (className) item.className = className
    return item
  }
  async function users() {
    const rows = await api(base + '/users?offset=' + offset)
    el('users-panel').hidden = false
    el('users').replaceChildren()
    for (const row of rows) {
      const item = node('div', '', 'user')
      item.append(
        node('strong', row.principal?.display_name || row.email),
        node('p', row.email),
        node('p', '主体：' + row.principal_id, 'hint'),
        node('p', row.principal?.status === 'active' ? '正常' : '已禁用', 'hint'),
      )
      const actions = node('div', '', 'row')
      const select = node('button', '配置角色')
      select.onclick = () => {
        el('bindings-panel').hidden = false
        el('binding-form').elements.principalId.value = row.principal_id
        el('bindings-panel').scrollIntoView({ behavior: 'smooth' })
      }
      actions.append(select)
      if (row.principal_id !== actorId) {
        const toggle = node('button', row.principal?.status === 'active' ? '禁用账号' : '启用账号')
        toggle.onclick = async () => {
          try {
            await api(
              base + '/users/' + encodeURIComponent(row.id) + '/status',
              { status: row.principal?.status === 'active' ? 'disabled' : 'active' },
              'PUT',
            )
            message('账号状态已更新')
            await users()
          } catch (error) {
            message(error.message)
          }
        }
        actions.append(toggle)
      }
      item.append(actions)
      el('users').append(item)
    }
    if (!rows.length) el('users').append(node('p', '暂无用户'))
    el('previous').disabled = offset === 0
    el('next').disabled = rows.length < 50
    el('page-number').textContent = '第 ' + (offset / 50 + 1) + ' 页'
  }
  async function roles() {
    const data = await api('/rbac/roles')
    el('roles-panel').hidden = false
    el('permissions').textContent = '已声明权限：' + data.permissions.map((p) => p.key).join('、')
    el('roles').replaceChildren()
    for (const role of data.roles)
      el('roles').append(
        node(
          'div',
          role.name +
            ' (' +
            role.id +
            ')：' +
            data.grants
              .filter((g) => g.role_id === role.id)
              .map((g) => g.permission)
              .join('、'),
          'role',
        ),
      )
  }
  async function refresh() {
    for (const id of ['account', 'users-panel', 'roles-panel', 'bindings-panel'])
      el(id).hidden = true
    try {
      const data = await api('/auth/me')
      actorId = data.auth.principalId
      el('guest').hidden = true
      el('account').hidden = false
      el('welcome').textContent = data.principal.display_name
      el('principal').textContent = '主体：' + actorId
      for (const load of [users, roles]) {
        try {
          await load()
        } catch (error) {
          if (error.status !== 403) message(error.message)
        }
      }
      try {
        await api('/rbac/bindings/' + encodeURIComponent(actorId))
        el('bindings-panel').hidden = false
      } catch (error) {
        if (error.status !== 403) message(error.message)
      }
    } catch (error) {
      el('guest').hidden = false
      if (error.status !== 401) message(error.message)
    }
  }
  bindForm('role-form', async (values) => {
    await api(
      '/rbac/roles/' + encodeURIComponent(values.id),
      {
        name: values.name,
        permissions: values.permissions
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      },
      'PUT',
    )
    message('角色已保存')
    await roles()
  })
  bindForm('binding-form', async (values, action) => {
    await api(
      '/rbac/bindings/' + encodeURIComponent(values.principalId),
      { roleId: values.roleId, scope: values.scope, enabled: action === 'grant' },
      'PUT',
    )
    message('角色绑定已更新')
    await bindings()
  })
  async function bindings() {
    const id = el('binding-form').elements.principalId.value
    if (!id) throw new Error('请先填写主体标识')
    const rows = await api('/rbac/bindings/' + encodeURIComponent(id))
    el('bindings').textContent = rows.length
      ? rows
          .map(
            (row) =>
              '角色：' +
              row.role_id +
              '\n范围：' +
              row.scope +
              '\n来源：' +
              row.source +
              '\n有效期：' +
              (row.expires_at ? new Date(row.expires_at).toLocaleString() : '长期'),
          )
          .join('\n\n')
      : '暂无角色绑定'
  }
  el('load-bindings').onclick = () => bindings().catch((error) => message(error.message))
  el('refresh-users').onclick = () => users().catch((error) => message(error.message))
  el('previous').onclick = () => {
    offset = Math.max(0, offset - 50)
    users().catch((error) => message(error.message))
  }
  el('next').onclick = () => {
    offset += 50
    users().catch((error) => message(error.message))
  }
  refresh().catch((error) => message(error.message))
}
