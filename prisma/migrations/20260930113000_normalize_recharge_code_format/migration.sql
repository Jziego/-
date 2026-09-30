-- 存量清洗：兑换码库存统一为无横杠格式（与 redeem 归一化查询口径一致）
-- 生成端历史上网入库带横杠串，redeem 按 normalizeRedeemCode（去全部非字母数字+大写）查询，永远 miss
UPDATE "RechargeCode" SET "code" = REPLACE("code", '-', '');
