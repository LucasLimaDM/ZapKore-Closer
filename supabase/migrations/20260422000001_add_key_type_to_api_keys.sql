alter table user_api_keys
  add column if not exists key_type text not null default 'ai'
  check (key_type in ('ai', 'audio'));
