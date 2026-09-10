<script setup lang="ts">
const layers = [
  { number: '01', title: '定义能力', detail: '通过契约与注册表连接服务，让消费方只关心能力。' },
  {
    number: '02',
    title: '组合智能体',
    detail: '以系统提示词、工具、Skill 和 MCP 服务组成 Agent 预设。',
  },
  {
    number: '03',
    title: '接入工作现场',
    detail: '面向网页登录、网站嵌入和工作 IM，统一身份与空间边界。',
  },
]
</script>

<template>
  <main>
    <header>
      <a class="brand" href="#">✳ Antarestra</a>
      <span class="stage">项目初始化 · 0.1</span>
    </header>
    <section class="hero" aria-labelledby="hero-title">
      <p class="eyebrow">开放组合 · 独立演进</p>
      <h1 id="hero-title">一个空间，<br />无限种智能体。</h1>
      <p class="intro">
        为多用户、多 Agent 而设计的 Cloud AI Harness。<br />以 Cordis
        为核心，让每一项能力都成为可组合、可卸载的插件。
      </p>
      <a class="action" href="#architecture">了解项目结构 <span aria-hidden="true">↗</span></a>
      <div class="orbit" aria-hidden="true"><span>✳</span></div>
    </section>
    <section id="architecture" class="layers" aria-label="架构方向">
      <article v-for="layer in layers" :key="layer.number">
        <span class="number">{{ layer.number }}</span>
        <h2>{{ layer.title }}</h2>
        <p>{{ layer.detail }}</p>
      </article>
    </section>
    <aside class="notice">
      <strong>从可运行的骨架开始</strong>
      <p>
        当前提供 Vue 页面壳与 Cordis 双实例演示。登录、聊天、pi-agent、pi-ai、Skill、MCP 和 IM
        接入将在后续实现；本页面尚未连接后端。
      </p>
    </aside>
    <footer><span>Antarestra</span><span>TypeScript · Vue · Cordis · pnpm</span></footer>
  </main>
</template>
