import { createEffect, createMemo, Show, type ParentProps } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { SDKProvider, useSDK } from "@/context/sdk"
import { SyncProvider, useSync } from "@/context/sync"
import { LocalProvider } from "@/context/local"
import { base64Decode } from "@opencode-ai/util/encode"
import { DataProvider } from "@opencode-ai/ui/context"
import { iife } from "@opencode-ai/util/iife"
import type { QuestionAnswer } from "@opencode-ai/sdk/v2"

export default function Layout(props: ParentProps) {
  const params = useParams()
  const navigate = useNavigate()
  const directory = createMemo(() => {
    return base64Decode(params.dir!)
  })
  return (
    <Show when={params.dir} keyed>
      <SDKProvider directory={directory()}>
        <SyncProvider>
          {iife(() => {
            const sync = useSync()
            const sdk = useSDK()
            let lastWorktree: string | undefined
            const respond = (input: {
              sessionID: string
              permissionID: string
              response: "once" | "always" | "reject"
            }) => sdk.client.permission.respond(input)

            const replyToQuestion = (input: { requestID: string; answers: QuestionAnswer[] }) =>
              sdk.client.question.reply(input)

            const rejectQuestion = (input: { requestID: string }) => sdk.client.question.reject(input)

            const navigateToSession = (sessionID: string) => {
              navigate(`/${params.dir}/session/${sessionID}`)
            }

            createEffect(() => {
              const worktree = sync.project?.worktree
              if (!worktree || worktree === lastWorktree) return
              lastWorktree = worktree
              void sdk.client.global.cwd.set({directory: worktree})
            })

            return (
              <DataProvider
                data={sync.data}
                directory={directory()}
                onPermissionRespond={respond}
                onQuestionReply={replyToQuestion}
                onQuestionReject={rejectQuestion}
                onNavigateToSession={navigateToSession}
              >
                <LocalProvider>{props.children}</LocalProvider>
              </DataProvider>
            )
          })}
        </SyncProvider>
      </SDKProvider>
    </Show>
  )
}
