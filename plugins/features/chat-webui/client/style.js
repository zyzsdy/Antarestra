export const style = `
.chat-app { display:flex; height:100dvh; min-height:540px; background:#fff; color:#28292c; font-size:14px; }
.chat-app a { color:inherit; text-decoration:none; }
.chat-app button { color:inherit; }
.chat-sidebar { width:268px; flex-shrink:0; background:#f7f7f5; padding:28px 18px 16px; display:flex; flex-direction:column; border-right:1px solid #eeefeb; }
.chat-brand { display:flex; align-items:center; gap:10px; font-size:21px; font-weight:650; padding:0 10px 32px; letter-spacing:-.7px; }
.chat-logo { font-size:32px; color:#527560; }
.chat-new { display:flex; gap:12px; align-items:center; padding:13px 16px; background:white; border:1px solid #dedfd9; border-radius:10px; text-align:left; font-weight:600; }
.chat-history { flex:1; padding:32px 12px; }
.chat-history h2 { font-size:12px; color:#858780; font-weight:500; margin:0 0 28px; }
.chat-history p { font-size:13px; color:#7b7e78; }
.chat-history small { display:block; color:#959790; line-height:1.8; max-width:165px; }
.chat-workspace { display:flex; align-items:center; gap:12px; padding:16px 10px; border-bottom:1px solid #e3e5de; }
.chat-workspace>span { font-size:23px; color:#67866d; }
.chat-workspace strong,.chat-profile strong { display:block; font-size:13px; font-weight:550; overflow-wrap:anywhere; }
.chat-workspace small,.chat-profile small { display:block; color:#888b83; font-size:11px; margin-top:5px; }
.chat-profile { display:flex; gap:10px; align-items:center; padding:18px 10px 0; }
.chat-profile>div { flex:1; min-width:0; }
.chat-avatar { width:34px; height:34px; border-radius:50%; background:#e0e7db; display:grid; place-items:center; color:#53674f; }
.chat-main { flex:1; min-width:0; display:flex; flex-direction:column; }
.chat-header { padding:26px 36px; display:flex; align-items:center; justify-content:space-between; }
.chat-header strong { font-size:15px; font-weight:550; }
.chat-preview { font-size:11px; color:#8a8c83; border:1px solid #e4e6df; padding:5px 9px; border-radius:6px; }
.chat-welcome { width:min(760px,100%); margin:auto; padding:40px 32px 50px; text-align:center; }
.chat-spark { font-size:52px; color:#60846d; margin-bottom:24px; }
.chat-eyebrow { font-size:12px; color:#7c877d; letter-spacing:3px; }
.chat-welcome h1 { font-size:clamp(25px,3vw,36px); font-weight:550; letter-spacing:-1px; margin:14px 0; }
.chat-subtitle { color:#969790; font-size:13px; line-height:1.8; }
.chat-suggestions { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; text-align:left; margin-top:40px; }
.chat-suggestions button { display:flex; flex-direction:column; text-align:left; gap:10px; border:1px solid #e8e9e3; background:#fff; border-radius:12px; padding:18px; }
.chat-suggestions button:hover { background:#f8faf6; border-color:#becaba; }
.suggestion-icon { color:#6c806a; font-size:20px; margin-bottom:8px; }
.chat-suggestions strong { font-size:13px; font-weight:550; }
.chat-suggestions small { color:#96998f; font-size:11px; line-height:1.7; }
.chat-composer-area { width:min(820px,100%); margin:0 auto; padding:0 32px 20px; }
.chat-composer { border:1px solid #e3e5dd; border-radius:18px; padding:18px 20px 12px; box-shadow:0 4px 20px #263a2410; }
.chat-composer textarea { width:100%; resize:none; border:0; background:transparent; outline:none; font-size:14px; }
.chat-composer textarea::placeholder { color:#a1a398; }
.chat-composer>div { display:flex; align-items:center; justify-content:space-between; }
.chat-composer span { font-size:11px; color:#a0a397; }
.chat-composer button { background:#e8ece3; border:0; border-radius:50%; width:32px; height:32px; color:#9da795; font-size:22px; }
.chat-composer-area>p { text-align:center; font-size:11px; color:#a2a59b; margin:12px 0 0; }
.chat-menu,.chat-backdrop { display:none; }
.chat-error { max-width:600px; margin:15vh auto; padding:24px; }
@media(max-width:760px) {
.chat-sidebar { position:fixed; top:0; bottom:0; left:0; z-index:30; transform:translateX(-100%); transition:transform .2s; }
.sidebar-open .chat-sidebar { transform:translateX(0); }
.chat-backdrop { display:block; position:fixed; inset:0; background:#0004; border:0; z-index:20; }
.chat-menu { display:inline-block; background:none; border:0; font-size:20px; margin-right:16px; padding:0; }
.chat-header { padding:20px; }
.chat-welcome { padding:26px 20px; }
.chat-spark { margin-bottom:18px; font-size:40px; }
.chat-subtitle { max-width:270px; margin:0 auto; }
.chat-suggestions { gap:8px; margin-top:26px; }
.chat-suggestions button { padding:12px 10px; }
.chat-suggestions small { display:none; }
.chat-suggestions strong { font-size:12px; line-height:1.6; }
.chat-composer-area { padding:14px 16px 20px; }
}
`
