import 'server-only'

import { createAI, createStreamableUI, getMutableAIState } from 'ai/rsc'
import { createOpenAI } from '@ai-sdk/openai'

import { nanoid } from '@/lib/utils'
import {
  FollowUpQuestionsSchema,
  isProspectObj,
  linksObj,
  needsHelpObj
} from '../inkeep-qa-schema'
import { ChatMessage } from '@/components/chat-message'
import { LoadingGrid } from '@/components/loading'
import { Button } from '@/components/ui/button'
import { Message, streamObject } from 'ai'
import { z } from 'zod'
import { IconCaretRight, IconUsers } from '@/components/ui/icons'

export const maxDuration = 300

const openai = createOpenAI({
  apiKey: process.env.INKEEP_API_KEY,
  baseURL: 'https://api.inkeep.com/v1'
})

async function submitUserMessage(content: string) {
  'use server'

  const aiState = getMutableAIState<typeof AI>()

  aiState.update({
    ...aiState.get(),
    messages: [
      ...aiState.get().messages,
      {
        id: nanoid(),
        role: 'user',
        content
      }
    ]
  })

  const chatMessage = createStreamableUI()
  chatMessage.update(<LoadingGrid />)

  try {
    runAsyncFnWithoutBlocking(async () => {
      const result = await streamObject({
        model: openai('inkeep-context-gpt-4o'),
        system: `
            You are a helpful AI assistant for Inkeep. Your primary goal is to provide accurate and relevant information to users based on the information sources you have.

            Follow these guidelines:
            1. ALWAYS respond with message content in the "content" property. If you cannot provide a response, a "needsHelpObj" object.
            2. If you have links to relevant information, return a "linksObj" object along with message content in the "content" property.
            3. If the user asks about access to the platform, pricing, plans, or costs, return a "isProspectObj" object along with message content in the "content" property.
            4. If the user is not satisfied with the experience and needs help, support, or further assistance, return a "needsHelpObj" object along with message content in the "content" property.
            5. ALWAYS anticipate the user's next questions and provide them in the "followUpQuestions" property. DO NOT list or include these questions in the "content" property. These should be questions the user would ask next or that would be related to their previous questions. These need to be worded from the user's perspective.
            5. Maintain a friendly and professional tone.
            6. Prioritize user satisfaction and clarity in your responses.
          `,
        messages: [
          ...aiState.get().messages.map((message: any) => ({
            role: message.role,
            content: message.content,
            name: 'inkeep-context-user-message',
            id: message.id
          }))
        ],
        mode: 'json',
        schema: z
          .object({
            linksObj: linksObj.nullish(),
            isProspectObj: isProspectObj.nullish(),
            needsHelpObj: needsHelpObj.nullish(),
            content: z
              .string()
              .describe('REQUIRED response message content')
              .nullish(),
            followUpQuestions: FollowUpQuestionsSchema.nullish()
          })
          .nullish()
      })

      const { partialObjectStream } = result

      let fullResponseMessage = {
        id: nanoid(),
        content: '',
        role: 'assistant'
      } as Message

      let objectsToHandle: {
        isProspectObj: z.infer<typeof isProspectObj> | {}
        needsHelpObj: z.infer<typeof needsHelpObj> | {}
        linksObj: z.infer<typeof linksObj> | {}
      } = {
        isProspectObj: {},
        needsHelpObj: {},
        linksObj: {}
      }

      let followUpQuestions: string[] = []

      try {
        for await (const partialStream of partialObjectStream) {
          if (partialStream?.content) {
            fullResponseMessage.content = partialStream.content
          }

          const messageToShow = <ChatMessage message={fullResponseMessage} />
          chatMessage.update(messageToShow)

          if (partialStream?.isProspectObj) {
            objectsToHandle.isProspectObj = partialStream.isProspectObj
          } else if (partialStream?.needsHelpObj) {
            objectsToHandle.needsHelpObj = partialStream.needsHelpObj
          } else if (partialStream?.linksObj) {
            objectsToHandle.linksObj = partialStream.linksObj
          }

          if (
            partialStream?.followUpQuestions &&
            partialStream?.followUpQuestions.length > 0
          ) {
            followUpQuestions = partialStream.followUpQuestions.filter(
              question => question !== undefined
            )
          }
        }

        const finalUIChatMessage = getFinalUI(
          fullResponseMessage,
          objectsToHandle,
          followUpQuestions
        )

        chatMessage.done(finalUIChatMessage)
        aiState.done({
          ...aiState.get(),
          messages: [...aiState.get().messages, fullResponseMessage]
        })
      } catch (error) {
        console.log('Error when processing partialObjectStream:', error)
        chatMessage.done(null)
        aiState.done({
          ...aiState.get()
        })
      }
    })

    return {
      id: nanoid(),
      display: chatMessage.value
    }
  } catch (error) {
    console.log('Error:', error)
    chatMessage.done(null)
    aiState.done({
      ...aiState.get()
    })
    return {
      id: nanoid(),
      display: null
    }
  }
}

export type AIState = {
  chatId: string
  messages: Message[]
}

export type UIState = {
  id: string
  display: React.ReactNode
}[]

export const AI = createAI<AIState, UIState>({
  actions: {
    submitUserMessage
  },
  initialUIState: [],
  initialAIState: { chatId: nanoid(), messages: [] }
})

const runAsyncFnWithoutBlocking = (fn: (...args: any) => Promise<any>) => {
  fn()
}

const getFinalUI = (
  fullResponseMessage: Message,
  objectsToHandle: any,
  followUpQuestions: string[]
): React.ReactNode => {
  if (fullResponseMessage.content === '') {
    return (
      <ChatMessage
        message={{
          ...fullResponseMessage,
          content:
            'Sorry, I am unable to provide a response at this time. Try again, or contact Inkeep for assistance.'
        }}
        customInfoCard={<SupportButton />}
      />
    )
  }

  if (Object.keys(objectsToHandle.needsHelpObj).length > 0) {
    return (
      <ChatMessage
        message={fullResponseMessage}
        customInfoCard={<SupportButton />}
        followUpQuestions={followUpQuestions}
      />
    )
  }

  if (Object.keys(objectsToHandle.isProspectObj).length > 0) {
    return (
      <ChatMessage
        message={fullResponseMessage}
        customInfoCard={<IsProspectCard />}
        followUpQuestions={followUpQuestions}
      />
    )
  }

  if (Object.keys(objectsToHandle.linksObj).length > 0) {
    const toolParsed = linksObj.safeParse(objectsToHandle.linksObj)
    return (
      <ChatMessage
        message={fullResponseMessage}
        links={toolParsed.data?.links}
        followUpQuestions={followUpQuestions}
      />
    )
  }

  return (
    <ChatMessage
      message={fullResponseMessage}
      followUpQuestions={followUpQuestions}
    />
  )
}

function SupportButton() {
  return (
    <div className="pt-8">
      <Button asChild variant="outline">
        <a href="https://inkeep.com" target="_blank" rel="noreferrer">
          <IconUsers className="size-4 text-muted-foreground mr-2" />
          <div>Get support</div>
        </a>
      </Button>
    </div>
  )
}

function IsProspectCard() {
  return (
    <div className="pt-8">
      <Button asChild variant="outline">
        <a href="https://inkeep.com" target="_blank" rel="noreferrer">
          <div>Schedule a demo</div>
          <IconCaretRight className="size-4 text-muted-foreground ml-2" />
        </a>
      </Button>
    </div>
  )
}
