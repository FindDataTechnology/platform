# Design: add-cockpit-edge-graph

## D1 · 纯函数布局 + 无依赖 SVG

`computeGraph(members, edges)`:虚拟节点(cron:<expr>/事件源)+岗位节点;分层=最长路(只沿显式边,忽略回边:拓扑序计算时跳过指向已访问层的边);坐标 layer*220+pad、层内 index*76+pad。渲染:SVG `<path>` 三次贝塞尔(源右缘→目标左缘)+每类型一色 marker;芯片=rect+text(截断)+kind 缩写徽章;`<title>` 悬停(边含 kind/两端/裁决信息,节点含岗位全名)。

## D2 · 隐式不画边

dispatch+implicit 边在图前过滤;聚合条(immpicitAll)放图上方。显式 dispatch 边照画。

## D3 · 位置与降级

编排区:标题行+聚合条+图(横向滚动容器)+既有文字列表(保留)。edges 为空但有 mode(supervisor)→只显聚合条无图。
