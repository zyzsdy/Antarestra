<script setup lang="ts">
import { AntarestraLogo } from '@antarestra/webui/components'
import { UsersIcon, PuzzlePieceIcon, ShieldCheckIcon } from '@antarestra/webui/icons'
</script>

<template>
  <section class="welcome">
    <div>
      <span class="tag">工作台</span>
      <h2>欢迎来到管理控制台</h2>
      <p>在这里管理用户、角色与访问权限。</p>
    </div>
    <AntarestraLogo class="illustration" :size="120" decorative />
  </section>
  <div class="cards">
    <section>
      <UsersIcon class="icon" aria-hidden="true" />
      <h3>用户与权限</h3>
      <p>通过左侧菜单查看本地用户、维护角色权限，并为用户分配角色。</p>
    </section>
    <section>
      <PuzzlePieceIcon class="icon" aria-hidden="true" />
      <h3>插件扩展</h3>
      <p>已启用插件提供的管理页面会自动显示在对应菜单分组中。</p>
    </section>
    <section>
      <ShieldCheckIcon class="icon" aria-hidden="true" />
      <h3>按权限访问</h3>
      <p>后台访问与具体操作分别授权，每次数据访问都由服务端校验权限。</p>
    </section>
  </div>
</template>
<style scoped>
.welcome {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
  background: #eaf0ff;
  border: 1px solid #dce5fc;
  border-radius: 12px;
  padding: 32px;
  margin-bottom: 24px;
}
.tag {
  color: #5273c9;
  font-size: 12px;
}
h2 {
  margin: 12px 0;
  font-size: 24px;
  color: #253b6b;
}
p {
  color: #71809a;
  line-height: 1.9;
  margin-bottom: 0;
}
.illustration {
  width: 120px;
  height: 100px;
  margin: 0 24px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}
.cards section {
  background: white;
  border: 1px solid #e5eaf3;
  border-radius: 10px;
  padding: 26px;
}
.icon {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  padding: 8px;
  background: #f0f4ff;
  color: #5273c9;
  border-radius: 10px;
  font-size: 25px;
}
h3 {
  margin: 20px 0 12px;
  font-size: 16px;
}
@media (max-width: 1000px) {
  .cards {
    grid-template-columns: 1fr;
  }
  .illustration {
    display: none;
  }
}
@media (max-width: 760px) {
  .welcome {
    padding: 24px;
  }
  h2 {
    font-size: 20px;
  }
}
</style>
