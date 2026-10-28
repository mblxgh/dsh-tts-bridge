-- gosense.lua — 进游戏读盘，不预设任何尺寸/名字/高度
-- 全部从棋盘自己的 snapPoints 推：路数、格距、原点
-- 输出一条 JSON| 前缀的 print
local GRID_EPS = 0.12     -- 同一条网格线的去重容差
local MATCH_EPS = 0.42    -- 棋子到网格线的最大允许误差（< 半步 0.4775）
local EDGE = 0.6          -- 盘外判定放宽（单位：格）

local function main()
  -- 1. 找棋盘：取 snapPoints 最多的那个 Board
  local boards = {}
  for _, o in ipairs(getAllObjects()) do
    if tostring(o.type) == 'Board' then
      local ok, pts = pcall(function() return o.getSnapPoints() end)
      if ok and pts and #pts > 0 then
        boards[#boards + 1] = { obj = o, pts = pts, n = #pts }
      end
    end
  end
  if #boards == 0 then return { ok = false, error = '桌上没有带吸附点的棋盘' } end
  table.sort(boards, function(a, b) return a.n > b.n end)
  local B = boards[1]

  -- 2. 从吸附点抽网格线
  local rawX, rawZ = {}, {}
  for _, pt in ipairs(B.pts) do
    rawX[#rawX + 1] = pt.position.x
    rawZ[#rawZ + 1] = pt.position.z
  end
  table.sort(rawX); table.sort(rawZ)
  local function uniq(sorted)
    local r = {}
    for _, v in ipairs(sorted) do
      if #r == 0 or math.abs(v - r[#r]) > GRID_EPS then r[#r + 1] = v end
    end
    return r
  end
  local gx, gz = uniq(rawX), uniq(rawZ)
  if #gx < 2 or #gz < 2 then return { ok = false, error = '网格线不足：' .. #gx .. 'x' .. #gz } end

  local stepX = (#gx > 1) and (gx[#gx] - gx[1]) / (#gx - 1) or 0
  local stepZ = (#gz > 1) and (gz[#gz] - gz[1]) / (#gz - 1) or 0

  local bp = B.obj.getPosition()
  local br = B.obj.getRotation()
  local rotated = math.abs(br.y) > 0.01 or math.abs(br.x) > 0.01 or math.abs(br.z) > 0.01

  local function nearest(grid, v)
    local bi, bd = nil, nil
    for k = 1, #grid do
      local d = math.abs(v - grid[k])
      if bd == nil or d < bd then bd, bi = d, k end
    end
    return bi, bd
  end

  -- 3. 收棋子
  local stones, offboard, unknown = {}, {}, {}
  local halfX = math.abs(stepX) * EDGE
  local halfZ = math.abs(stepZ) * EDGE

  local function colorOf(o)
    local n = tostring(o.name):lower()
    if n:find('black', 1, true) or n:find('dark', 1, true) then return 'B' end
    if n:find('white', 1, true) or n:find('light', 1, true) then return 'W' end
    local ok, c = pcall(function() return o.getColorTint() end)
    if ok and c then
      return ((c.r + c.g + c.b) / 3 < 0.45) and 'B' or 'W'
    end
    return '?'
  end

  -- 棋罐的 type 同样是 GoPiece，靠名字/类型分不开，只能靠体积：
  -- 一颗子不可能比一个交叉格宽太多。上限取 1.5 倍格距，全部由棋盘自己推。
  local maxPieceSpan = math.max(math.abs(stepX), math.abs(stepZ)) * 1.5
  local function isPiece(o)
    local t = tostring(o.type)
    local n = tostring(o.name):lower()
    local named = (t == 'GoPiece') or (n:find('piece', 1, true) ~= nil) or (n:find('stone', 1, true) ~= nil)
    if not named then return false end
    if n:find('bowl', 1, true) or n:find('canister', 1, true) or n:find('jar', 1, true) then return false end
    local okb, b = pcall(function() return o.getBounds() end)
    if okb and b and b.size then
      local span = math.max(b.size.x, b.size.y, b.size.z)
      if span > maxPieceSpan then return false end
    end
    return true
  end

  local bigSkip = {}
  for _, o in ipairs(getAllObjects()) do
    local t0 = tostring(o.type)
    local n0 = tostring(o.name):lower()
    local looksPiece = (t0 == 'GoPiece') or (n0:find('piece', 1, true) ~= nil) or (n0:find('stone', 1, true) ~= nil)
    if looksPiece and not isPiece(o) then
      local okb, b = pcall(function() return o.getBounds() end)
      bigSkip[#bigSkip + 1] = {
        guid = o.guid,
        name = tostring(o.name),
        span = (okb and b and b.size) and math.max(b.size.x, b.size.y, b.size.z) or nil,
      }
    end
    if isPiece(o) then
      local okp, p = pcall(function() return o.getPosition() end)
      if okp and p then
        local inX = p.x >= gx[1] - halfX and p.x <= gx[#gx] + halfX
        local inZ = p.z >= gz[1] - halfZ and p.z <= gz[#gz] + halfZ
        if inX and inZ then
          local ci, dx = nearest(gx, p.x)
          local cj, dz = nearest(gz, p.z)
          local col = colorOf(o)
          if col == '?' then
            unknown[#unknown + 1] = { guid = o.guid, name = tostring(o.name), x = p.x, y = p.y, z = p.z }
          else
            stones[#stones + 1] = {
              guid = o.guid, color = col,
              i = ci - 1, j = cj - 1,
              x = p.x, y = p.y, z = p.z,
              err = math.max(dx, dz),
            }
          end
        else
          offboard[#offboard + 1] = {
            guid = o.guid, name = tostring(o.name),
            x = p.x, y = p.y, z = p.z,
          }
        end
      end
    end
  end

  return {
    ok = true,
    board = {
      guid = B.obj.guid,
      name = tostring(B.obj.name),
      cols = #gx, rows = #gz,
      stepX = stepX, stepZ = stepZ,
      x0 = gx[1], z0 = gz[1],
      x1 = gx[#gx], z1 = gz[#gz],
      y = bp.y,
      posX = bp.x, posZ = bp.z,
      rotated = rotated,
      snapCount = B.n,
      boardCandidates = #boards,
    },
    gridX = gx, gridZ = gz,
    stones = stones,
    offboard = offboard,
    unknown = unknown,
    bigSkip = bigSkip,
    maxPieceSpan = maxPieceSpan,
  }
end

local ok, res = pcall(main)
if ok then
  print('JSON|' .. JSON.encode(res))
else
  print('JSON|' .. JSON.encode({ ok = false, error = tostring(res) }))
end
