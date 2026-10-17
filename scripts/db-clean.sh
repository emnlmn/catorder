#!/bin/sh
# Drops every live WhatsApp message (and its order, reads, replies) plus the assigned numbers; the sample data stays.
# Stop the server first when you can; the sample messages and data/cache are not touched.
cd "$(dirname "$0")/.." || exit 1
sqlite3 "${CATORDER_DB:-./catorder.db}" "
create temp table o as select distinct order_id from order_messages where message_id like 'wa-live-%';
delete from lines where order_id in (select order_id from o);
delete from order_messages where order_id in (select order_id from o);
delete from orders where id in (select order_id from o);
delete from replies where message_id like 'wa-live-%';
delete from runs where message_id like 'wa-live-%';
delete from senders where message_id like 'wa-live-%';
delete from traces where message_id like 'wa-live-%';
delete from messages where id like 'wa-live-%';
delete from phones;"
rm -f "${CATORDER_INBOX_DIR:-data/inbox}"/*
echo "live messages cleared"
