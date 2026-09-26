/** All selectors are plugin-scoped. No body rules, host CSS variables, or global shortcuts. */
export const WORKBENCH_CSS = `
[data-mc-scrim]{position:fixed;inset:0;z-index:1000;background:#05090bc9}
.mc-launch{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:3px;padding:5px 10px;cursor:pointer}
[data-mc-workbench]{--mc-bg:#151b20;--mc-rail:#10161a;--mc-detail:#1b2228;--mc-line:#35434c;--mc-soft:#28343d;--mc-fg:#e0e6eb;--mc-muted:#a6b2bc;--mc-accent:#e7d388;--mc-live:#90c9c2;--mc-bad:#f0b3a0;position:fixed;inset:16px;z-index:1000;display:flex;flex-direction:column;background:var(--mc-bg);color:var(--mc-fg);border:1px solid var(--mc-line);border-radius:7px;overflow:hidden;font:14px/1.6 "Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;isolation:isolate;text-align:left;color-scheme:dark}
[data-mc-workbench] *,[data-mc-workbench] *::before,[data-mc-workbench] *::after{box-sizing:border-box}
[data-mc-workbench] button,[data-mc-workbench] input,[data-mc-workbench] textarea,[data-mc-workbench] select{font:inherit;letter-spacing:normal;box-shadow:none;max-width:100%;color:inherit}
[data-mc-workbench] button{cursor:pointer;border:1px solid transparent;background:transparent;border-radius:3px;padding:7px 10px;min-height:34px;line-height:1.45;white-space:normal}
[data-mc-workbench] button:hover:not(:disabled){background:#29353e}
[data-mc-workbench] button:disabled{opacity:.48;cursor:not-allowed}
[data-mc-workbench] :focus-visible{outline:2px solid var(--mc-accent);outline-offset:3px}
[data-mc-workbench] h1,[data-mc-workbench] h2,[data-mc-workbench] h3,[data-mc-workbench] h4,[data-mc-workbench] p{margin:0;overflow-wrap:anywhere}
[data-mc-workbench] h1{font-size:23px;line-height:1.55;font-weight:650;letter-spacing:.01em}
[data-mc-workbench] h2{font-size:21px;font-weight:650;line-height:1.45}
[data-mc-workbench] h3{font-size:15px;font-weight:600;line-height:1.55}
[data-mc-workbench] small{font-size:12px;line-height:1.6}
[data-mc-workbench] code,[data-mc-workbench] pre{font:12px/1.7 "Cascadia Mono",Consolas,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
[data-mc-workbench] pre{margin:12px 0;padding:14px;background:var(--mc-rail);border:1px solid var(--mc-soft);max-height:340px;overflow:auto}
[data-mc-workbench] input,[data-mc-workbench] select,[data-mc-workbench] textarea{border:1px solid var(--mc-line);border-radius:3px;background:#10171c;padding:9px 10px;min-width:0;width:100%;outline-offset:2px}
[data-mc-workbench] textarea{resize:vertical;min-height:90px;line-height:1.7}
[data-mc-workbench] input::placeholder,[data-mc-workbench] textarea::placeholder{color:#8999a6}
[data-mc-workbench] input[type=checkbox]{width:16px;height:16px;accent-color:var(--mc-accent);flex:none;margin:0}
[data-mc-workbench] .mc-primary{background:var(--mc-accent);border-color:var(--mc-accent);color:#191b18;font-weight:650}
[data-mc-workbench] .mc-primary:hover:not(:disabled){background:#f2df9b}
[data-mc-workbench] .mc-secondary{border-color:var(--mc-line)}
[data-mc-workbench] .mc-danger{color:var(--mc-bad)}
[data-mc-workbench] .mc-muted{color:var(--mc-muted)}
[data-mc-workbench] .mc-eyebrow{font:10px/1.4 "Cascadia Mono",Consolas,monospace;letter-spacing:.14em;color:var(--mc-muted);text-transform:uppercase}
[data-mc-workbench] .mc-icon{display:inline-block;width:16px;height:16px;vertical-align:-3px;flex:none}
[data-mc-workbench] .mc-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
[data-mc-workbench] .mc-actions.end{justify-content:flex-end}
[data-mc-workbench] .mc-between{display:flex;align-items:center;justify-content:space-between;gap:12px}
[data-mc-workbench] .mc-top{min-height:62px;display:flex;align-items:center;gap:12px;padding:12px 22px;border-bottom:1px solid var(--mc-line);flex:none}
[data-mc-workbench] .mc-brand{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--mc-accent);color:var(--mc-accent);font:600 10px monospace}
[data-mc-workbench] .mc-top strong{font-size:15px}
[data-mc-workbench] .mc-top .mc-connection{margin-left:auto;font-size:12px;color:var(--mc-muted)}
[data-mc-workbench] .mc-dot{display:inline-block;width:5px;height:5px;border-radius:50%;margin-right:7px;background:currentColor;vertical-align:3px}
[data-mc-workbench] .mc-toast{background:#26332f;color:#d8e9df;border-bottom:1px solid var(--mc-line);padding:8px 20px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex:none;max-height:130px;overflow:auto;white-space:pre-wrap}
[data-mc-workbench] .mc-toast.error{background:#392923;color:#ffd0bc}
[data-mc-workbench] .mc-layout{display:grid;grid-template-columns:190px minmax(280px,355px) minmax(0,1fr);flex:1;min-height:0;min-width:0}
[data-mc-workbench] .mc-sidebar{display:flex;flex-direction:column;min-height:0;background:var(--mc-rail);border-right:1px solid var(--mc-line);padding:18px 12px 12px}
[data-mc-workbench] .mc-sidebar .mc-between{padding:0 5px 10px;color:var(--mc-muted);font-size:12px}
[data-mc-workbench] .mc-projects{overflow:auto;flex:1;min-height:0;margin-top:12px;padding:6px 2px}
[data-mc-workbench] .mc-project-row{display:flex;gap:4px;align-items:center;margin:2px 0}
[data-mc-workbench] .mc-project-row>button:first-child{flex:1;min-width:0;text-align:left;display:flex;gap:8px;align-items:center;padding:10px 8px}
[data-mc-workbench] .mc-project-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[data-mc-workbench] .mc-project-row small{font:11px monospace;color:var(--mc-muted);flex:none}
[data-mc-workbench] .mc-project-row.selected{background:#263039;border-radius:3px}
[data-mc-workbench] .mc-sidebar footer{border-top:1px solid var(--mc-line);margin-top:12px;padding-top:10px;font-size:12px}
[data-mc-workbench] .mc-sidebar footer button{width:100%;text-align:left;color:var(--mc-muted)}
[data-mc-workbench] .mc-sidebar footer small{display:block;padding:8px;color:var(--mc-muted);font-size:10px}
[data-mc-workbench] .mc-queue{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--mc-line)}
[data-mc-workbench] .mc-queue-head{padding:24px 20px 12px;flex:none}
[data-mc-workbench] .mc-queue-head h2{margin:5px 0}
[data-mc-workbench] .mc-queue-head .mc-subline{color:var(--mc-muted);font-size:12px;margin:10px 0 16px}
[data-mc-workbench] .mc-search{position:relative}
[data-mc-workbench] .mc-search>svg{position:absolute;left:11px;top:12px;color:var(--mc-muted)}
[data-mc-workbench] .mc-search input{padding-left:34px;font-size:13px}
[data-mc-workbench] .mc-filter{display:flex;border-bottom:1px solid var(--mc-line);margin-top:14px;gap:0;flex-wrap:wrap}
[data-mc-workbench] .mc-filter button{font-size:12px;color:var(--mc-muted);padding:7px;min-height:31px;border-radius:2px 2px 0 0}
[data-mc-workbench] .mc-filter button[aria-pressed=true]{background:#29353e;color:var(--mc-fg)}
[data-mc-workbench] .mc-sortbar{font-size:11px;color:var(--mc-muted);margin-top:9px}
[data-mc-workbench] .mc-sortbar select{width:110px;border:0;background:transparent;padding:4px;font-size:11px}
[data-mc-workbench] .mc-task-list{overflow:auto;flex:1;min-height:0;padding:0 12px 12px;scrollbar-gutter:stable}
[data-mc-workbench] .mc-task-row{width:100%;padding:13px 11px;text-align:left;display:block;border-bottom:1px solid var(--mc-soft);border-radius:0}
[data-mc-workbench] .mc-task-row[aria-current=true]{background:#24303a;border:1px solid #526575;border-radius:4px}
[data-mc-workbench] .mc-task-row strong{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;line-height:1.6;font-size:14px;margin:6px 0}
[data-mc-workbench] .mc-task-row .mc-project-label{color:var(--mc-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-mc-workbench] .mc-task-row .mc-between{gap:8px;font-size:11px;min-width:0}
[data-mc-workbench] .mc-priority{color:var(--mc-accent);font-size:11px;flex:none}
[data-mc-workbench] .mc-priority.normal,[data-mc-workbench] .mc-priority.low{color:var(--mc-muted)}
[data-mc-workbench] .mc-signal{color:var(--mc-muted);font-size:12px;overflow-wrap:anywhere}
[data-mc-workbench] .mc-signal.live,[data-mc-workbench] .mc-signal.done{color:var(--mc-live)}
[data-mc-workbench] .mc-signal.attention{color:var(--mc-bad)}
[data-mc-workbench] .mc-signal.review{color:var(--mc-accent)}
[data-mc-workbench] .mc-detail{background:var(--mc-detail);min-width:0;min-height:0;display:flex;flex-direction:column}
[data-mc-workbench] .mc-detail-head{padding:24px 28px 0;flex:none}
[data-mc-workbench] .mc-detail-head h1{margin:12px 0}
[data-mc-workbench] .mc-detail-head .mc-between:first-child{font-size:12px;color:var(--mc-muted)}
[data-mc-workbench] .mc-detail-head .mc-actions button{font-size:12px;color:var(--mc-muted)}
[data-mc-workbench] .mc-tabs{display:flex;gap:20px;border-bottom:1px solid var(--mc-line);margin-top:22px;flex-wrap:wrap}
[data-mc-workbench] .mc-tabs button{padding:10px 0;border:0;border-radius:0;color:var(--mc-muted);font-size:13px;position:relative}
[data-mc-workbench] .mc-tabs button[aria-selected=true]{color:var(--mc-fg)}
[data-mc-workbench] .mc-tabs button[aria-selected=true]:after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--mc-accent)}
[data-mc-workbench] .mc-detail-body{padding:22px 28px 32px;overflow:auto;min-height:0;flex:1;scrollbar-gutter:stable}
[data-mc-workbench] .mc-section{margin-bottom:28px}
[data-mc-workbench] .mc-section>h3,[data-mc-workbench] .mc-section>.mc-between{margin-bottom:12px}
[data-mc-workbench] .mc-prose{white-space:pre-wrap;line-height:1.95;overflow-wrap:anywhere}
[data-mc-workbench] .mc-criteria{padding:0;list-style:none;counter-reset:criteria;margin:0}
[data-mc-workbench] .mc-criteria li{counter-increment:criteria;display:flex;gap:18px;margin:12px 0;line-height:1.8;overflow-wrap:anywhere}
[data-mc-workbench] .mc-criteria li:before{content:counter(criteria,decimal-leading-zero);font:11px/2 monospace;color:var(--mc-muted);flex:none}
[data-mc-workbench] .mc-session-line{display:flex;gap:14px;align-items:center;width:100%;text-align:left!important;padding:13px 0!important}
[data-mc-workbench] .mc-session-line>div{flex:1;min-width:0;overflow-wrap:anywhere}
[data-mc-workbench] .mc-session-line strong,[data-mc-workbench] .mc-session-line small{display:block}
[data-mc-workbench] .mc-session-line small{color:var(--mc-muted);margin-top:3px}
[data-mc-workbench] .mc-next{border-block:1px solid var(--mc-line);padding:20px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;margin:20px 0}
[data-mc-workbench] .mc-next small{color:var(--mc-muted);display:block;margin-bottom:3px}
[data-mc-workbench] details{border-top:1px solid var(--mc-soft);padding:13px 0;margin-top:12px}
[data-mc-workbench] summary{cursor:pointer;color:var(--mc-muted);font-size:12px}
[data-mc-workbench] details[open]>summary{margin-bottom:14px}
[data-mc-workbench] .mc-notice{background:#29302e;border:1px solid #455a53;padding:12px 14px;border-radius:3px;margin:12px 0;white-space:pre-wrap}
[data-mc-workbench] .mc-notice.error{background:#312824;border-color:#755447;color:#ffd0b9}
[data-mc-workbench] .mc-notice.warn{background:#302f23;border-color:#645e3d}
[data-mc-workbench] .mc-empty{padding:36px 22px;text-align:center;color:var(--mc-muted);margin:auto;max-width:470px}
[data-mc-workbench] .mc-empty h2,[data-mc-workbench] .mc-empty h3{color:var(--mc-fg);margin:12px 0 8px}
[data-mc-workbench] .mc-empty p{margin:10px 0 20px}
[data-mc-workbench] .mc-empty .mc-actions{justify-content:center}
[data-mc-workbench] .mc-empty>svg{width:30px;height:30px;color:var(--mc-accent)}
[data-mc-workbench] .mc-evidence{padding:16px 0;border-bottom:1px solid var(--mc-soft)}
[data-mc-workbench] .mc-evidence .mc-between{font-size:12px;margin-bottom:9px}
[data-mc-workbench] .mc-evidence h3{margin:8px 0}
[data-mc-workbench] .mc-evidence small{color:var(--mc-muted);display:block;margin-top:7px}
[data-mc-workbench] .mc-metadata{display:grid;grid-template-columns:86px minmax(0,1fr);gap:9px 12px;margin:18px 0}
[data-mc-workbench] .mc-metadata dt{color:var(--mc-muted);font-size:12px}
[data-mc-workbench] .mc-metadata dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
[data-mc-workbench] .mc-team-list{padding-left:20px;font-size:13px}
[data-mc-workbench] .mc-team-list li{padding:4px 0;overflow-wrap:anywhere}
[data-mc-workbench] dialog{color:var(--mc-fg);background:var(--mc-detail);border:1px solid #586771;border-radius:6px;padding:0;max-width:calc(100vw - 28px);width:620px;max-height:calc(100dvh - 40px);overflow:auto;font:inherit;color-scheme:dark}
[data-mc-workbench] dialog::backdrop{background:rgba(5,10,14,.78)}
[data-mc-workbench] .mc-dialog-head{position:sticky;top:0;background:var(--mc-detail);padding:18px 22px;border-bottom:1px solid var(--mc-line);z-index:1;display:flex;justify-content:space-between;align-items:center;gap:12px}
[data-mc-workbench] .mc-dialog-head h2{font-size:18px}
[data-mc-workbench] .mc-dialog-body{padding:20px 22px}
[data-mc-workbench] .mc-dialog-body>p{margin-bottom:16px;color:var(--mc-muted)}
[data-mc-workbench] .mc-dialog-foot{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding:16px 22px;border-top:1px solid var(--mc-line);background:var(--mc-detail)}
[data-mc-workbench] .mc-field{display:grid;gap:7px;margin:0 0 17px;font-size:13px}
[data-mc-workbench] .mc-field>span{color:var(--mc-muted)}
[data-mc-workbench] .mc-field small{color:var(--mc-muted)}
[data-mc-workbench] .mc-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
[data-mc-workbench] .mc-check{display:flex;gap:10px;align-items:flex-start;margin:10px 0;font-size:13px}
[data-mc-workbench] .mc-session-option{width:100%;display:flex;align-items:center;gap:12px;text-align:left;padding:13px 9px;border-bottom:1px solid var(--mc-line)}
[data-mc-workbench] .mc-session-option>span{min-width:0;flex:1;overflow-wrap:anywhere}
[data-mc-workbench] .mc-session-option strong,[data-mc-workbench] .mc-session-option small{display:block}
[data-mc-workbench] .mc-session-option small{color:var(--mc-muted);font-size:11px}
[data-mc-workbench] .mc-back{display:none}
[data-mc-workbench] .mc-inline-busy{width:100%;text-align:left;font-size:12px;color:var(--mc-accent);border-bottom:1px solid var(--mc-line);border-radius:0;padding:9px 20px}

[data-mc-workbench] .mc-form-grid .wide{grid-column:1/-1}
[data-mc-workbench] .mc-field{min-width:0}
[data-mc-workbench] fieldset.mc-field{border:1px solid var(--mc-line);padding:12px}
[data-mc-workbench] .mc-check-list{display:grid;gap:10px;max-height:200px;overflow:auto;padding:3px}
[data-mc-workbench] .mc-check-list label{display:flex;gap:9px;align-items:flex-start;overflow-wrap:anywhere}
[data-mc-workbench] .mc-optional{margin:20px 0;border-top:1px solid var(--mc-line);padding-top:15px}
[data-mc-workbench] .mc-optional summary{cursor:pointer;color:var(--mc-muted);padding:5px 0;margin-bottom:12px}
[data-mc-workbench] .mc-optional article{padding:14px 0;border-bottom:1px solid var(--mc-line)}
[data-mc-workbench] .mc-dialog-foot{position:sticky;bottom:0;display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;padding:16px 22px;background:var(--mc-detail);border-top:1px solid var(--mc-line);z-index:1}
[data-mc-workbench] .mc-dialog-foot>span{margin-right:auto;font-size:12px}
[data-mc-workbench] .mc-icon-button{font-size:22px;padding:0 8px}
[data-mc-workbench] .mc-run-activity{margin:14px 0;color:var(--mc-live)}
[data-mc-workbench] .mc-active-link{color:var(--mc-accent);text-align:left;font-size:12px;width:100%;margin-top:10px;border-top:1px solid var(--mc-line);padding:10px 0 0}
[data-mc-workbench] .mc-project-tools{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px}
[data-mc-workbench] .mc-project-tools button{font-size:12px;color:var(--mc-muted)}
[data-mc-workbench] .mc-queue-head h2{flex:1;min-width:0}
[data-mc-workbench] .mc-queue-head>.mc-between>.mc-primary{flex-shrink:0;max-width:112px}
[data-mc-workbench] .mc-footnote{font-size:12px;color:var(--mc-muted);margin-top:12px}
[data-mc-workbench] .mc-text-link{color:var(--mc-accent);padding-left:0}
[data-mc-workbench] .mc-dependency{display:block;text-align:left;width:100%;color:var(--mc-accent)}
[data-mc-workbench] .mc-session-options{max-height:42vh;overflow:auto}
[data-mc-workbench] .mc-session-line code{display:block;color:var(--mc-muted);font-size:11px}
[data-mc-workbench] .mc-team-list li{display:flex;justify-content:space-between;gap:10px}
@media(max-width:520px){[data-mc-workbench] .mc-sidebar{max-height:178px}[data-mc-workbench] .mc-sidebar footer{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 0;padding:2px 0 0}[data-mc-workbench] .mc-sidebar footer button{width:auto;min-height:28px;font-size:11px;padding:5px}[data-mc-workbench] .mc-sidebar footer small{display:none}[data-mc-workbench] .mc-dialog-head,[data-mc-workbench] .mc-dialog-foot{padding:14px 16px}}

@media(min-width:1500px){[data-mc-workbench] .mc-layout{grid-template-columns:210px minmax(335px,395px) minmax(0,1fr)}[data-mc-workbench] .mc-detail-head{padding-inline:38px}[data-mc-workbench] .mc-detail-body{padding-inline:38px}}
@media(max-width:1080px){[data-mc-workbench] .mc-layout{grid-template-columns:160px minmax(240px,290px) minmax(0,1fr)}[data-mc-workbench] .mc-queue-head{padding:20px 14px 10px}[data-mc-workbench] .mc-detail-head{padding:20px 20px 0}[data-mc-workbench] .mc-detail-body{padding:20px}[data-mc-workbench] h1{font-size:20px}}
@media(max-width:840px){[data-mc-workbench]{inset:8px}[data-mc-workbench] .mc-layout{grid-template-columns:155px minmax(0,1fr)}[data-mc-workbench] .mc-queue{border-right:0}[data-mc-workbench] .mc-detail{display:none}[data-mc-workbench][data-view=detail] .mc-layout{grid-template-columns:minmax(0,1fr)}[data-mc-workbench][data-view=detail] .mc-sidebar,[data-mc-workbench][data-view=detail] .mc-queue{display:none}[data-mc-workbench][data-view=detail] .mc-detail{display:flex}[data-mc-workbench] .mc-back{display:inline-flex;align-items:center;gap:6px}[data-mc-workbench] .mc-top .mc-eyebrow{display:none}[data-mc-workbench] .mc-top{padding:10px 14px}[data-mc-workbench] .mc-queue-head{padding:20px}[data-mc-workbench] .mc-next{align-items:flex-start}[data-mc-workbench] .mc-task-row{padding:15px 12px}}
@media(max-width:520px){[data-mc-workbench]{inset:0;border:0;border-radius:0}[data-mc-workbench] .mc-layout{display:flex;flex-direction:column}[data-mc-workbench] .mc-sidebar{max-height:178px;flex:none;border-right:0;border-bottom:1px solid var(--mc-line);padding:6px 10px}[data-mc-workbench] .mc-sidebar>.mc-between{padding-bottom:0}[data-mc-workbench] .mc-projects{display:flex;overflow-x:auto;flex:none;margin-top:0;padding:0 2px 6px}[data-mc-workbench] .mc-project-row{flex:none;max-width:190px}[data-mc-workbench] .mc-projects>.mc-project-row>button:last-child:not(:first-child){display:none}[data-mc-workbench] .mc-sidebar footer{display:flex}[data-mc-workbench] .mc-queue{flex:1;min-height:0}[data-mc-workbench] .mc-detail{flex:1}[data-mc-workbench] .mc-detail-head{padding:14px 16px 0}[data-mc-workbench] .mc-detail-body{padding:18px 16px}[data-mc-workbench] .mc-top strong{font-size:14px}[data-mc-workbench] .mc-top{gap:7px}[data-mc-workbench] .mc-connection{font-size:10px!important}[data-mc-workbench] .mc-form-grid{grid-template-columns:1fr;gap:0}[data-mc-workbench] .mc-tabs{gap:18px;margin-top:15px}[data-mc-workbench] .mc-next{flex-direction:column}[data-mc-workbench] dialog{max-height:calc(100dvh - 18px)}[data-mc-workbench] .mc-dialog-head,[data-mc-workbench] .mc-dialog-body,[data-mc-workbench] .mc-dialog-foot{padding:15px}}
@media(prefers-reduced-motion:no-preference){[data-mc-workbench] button{transition:background-color .12s,border-color .12s}}
`
