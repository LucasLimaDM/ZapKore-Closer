import { useState } from 'react'
import { useContacts } from '@/hooks/use-contacts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Search, MessageCircle, Clock } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { formatDistanceToNow } from 'date-fns'

export function ContactFeed() {
  const [search, setSearch] = useState('')
  const { contacts, loading } = useContacts(search)
  const navigate = useNavigate()

  return (
    <Card className="shadow-subtle border-border/40 rounded-3xl flex flex-col h-[500px] bg-white">
      <CardHeader className="pb-4 border-b border-border/40 px-6 pt-6">
        <CardTitle className="text-lg font-semibold flex justify-between items-center">
          Top Contacts
          <span className="text-[11px] font-semibold bg-zinc-100 text-zinc-600 px-2.5 py-1 rounded-full">
            {contacts.length} Total
          </span>
        </CardTitle>
        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <Input
            placeholder="Search contacts..."
            className="pl-9 bg-zinc-50 border-transparent focus-visible:bg-white focus-visible:ring-1 focus-visible:ring-zinc-300 rounded-full h-10 text-[13px] font-medium"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-0 scrollbar-hide">
        {loading ? (
          <div className="p-6 space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-4 animate-pulse">
                <div className="w-10 h-10 bg-zinc-100 rounded-full" />
                <div className="space-y-2 flex-1">
                  <div className="h-3.5 bg-zinc-100 rounded w-1/3" />
                  <div className="h-2.5 bg-zinc-100 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 p-6 text-center">
            <MessageCircle className="h-10 w-10 text-zinc-200 mb-3" />
            <p className="font-medium text-sm text-zinc-500">No contacts found</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/30">
            {contacts.map((contact) => (
              <li
                key={contact.id}
                onClick={() => navigate(`/app/chat/${contact.id}`)}
                className="p-4 px-6 hover:bg-zinc-50/50 cursor-pointer transition-colors flex items-center justify-between group"
              >
                <div className="flex items-center gap-3.5">
                  <Avatar className="h-10 w-10 border border-border/40 shadow-sm">
                    <AvatarImage src={contact.profile_picture_url || ''} />
                    <AvatarFallback className="bg-zinc-100 text-zinc-600 font-medium text-sm">
                      {contact.push_name ? contact.push_name.charAt(0).toUpperCase() : '#'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-semibold text-[14px] text-foreground tracking-tight truncate max-w-[150px] sm:max-w-[180px] group-hover:text-primary transition-colors">
                      {contact.push_name || 'Unknown Contact'}
                    </p>
                    <p className="text-[12px] font-medium text-muted-foreground truncate max-w-[150px] sm:max-w-[180px]">
                      {contact.remote_jid.split('@')[0]}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  {contact.score !== null && contact.score > 0 && (
                    <div className="text-[11px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md tabular-nums">
                      {contact.score} pts
                    </div>
                  )}
                  {contact.last_message_at && (
                    <div className="text-[11px] font-medium text-zinc-400 flex items-center gap-1 group-hover:text-zinc-600 transition-colors">
                      <Clock className="h-3 w-3" />
                      {formatDistanceToNow(new Date(contact.last_message_at), { addSuffix: true })}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
